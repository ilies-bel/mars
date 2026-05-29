/**
 * Tests for the Events tab — the unified trace-event stream page.
 *
 * Two complementary slices of coverage:
 *   1. Pure-helper tests for `toWireFilter` / `applyLocalPhaseFilter` /
 *      `sinceFromRange` — these exercise the multi-filter normalisation
 *      logic without rendering.
 *   2. Render snapshots driven by a pre-warmed React Query cache so the
 *      page's useQuery resolves synchronously inside renderToStaticMarkup
 *      (mirrors the pattern from TodoPageDetail.test.tsx).
 *
 * The legacy topology tests (depth layering, blocker chains, layered
 * rendering) are deliberately removed — that surface no longer exists.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { Mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { EventsResponse, TraceEvent } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

const { EventsPage, __test__ } = await import('./EventsPage')
const {
  toWireFilter,
  applyLocalPhaseFilter,
  sinceFromRange,
  initialFilterState,
  KIND_OPTIONS,
  SEVERITY_OPTIONS,
  PHASE_OPTIONS,
  TIME_RANGE_MS,
} = __test__

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeEvent = (overrides: Partial<TraceEvent> = {}): TraceEvent => ({
  id: 'ev-1',
  timestamp: new Date().toISOString(),
  kind: 'task_failed',
  severity: 'error',
  taskId: 't-1',
  originId: null,
  phase: 'verify',
  payload: { failureReasonCode: 'verify:typecheck' },
  ...overrides,
})

const EMPTY_RESPONSE: EventsResponse = { events: [], nextCursor: null }

const makeResponse = (
  events: TraceEvent[],
  nextCursor: string | null = null,
): EventsResponse => ({ events, nextCursor })

/**
 * Build a QueryClient pre-loaded with the response we want the initial
 * EventsPage query to resolve to. The query key must match the one
 * EventsPage computes — replicate its shape here.
 */
const QUERY_KEY_FOR = (state = initialFilterState()): unknown[] => [
  'events-page',
  state.range,
  [...state.severities].sort(),
  [...state.kinds].sort(),
  [...state.phases].sort(),
  state.taskId.trim(),
  state.originId.trim(),
  state.q.trim(),
]

const makeClient = (response: EventsResponse): QueryClient => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  qc.setQueryData(QUERY_KEY_FOR(), response)
  return qc
}

const renderPage = (qc: QueryClient): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <EventsPage />
    </QueryClientProvider>,
  )

// ---------------------------------------------------------------------------
// 1. Pure helper tests
// ---------------------------------------------------------------------------

describe('toWireFilter', () => {
  it('omits a multi-select when every option is selected (default state)', () => {
    const wire = toWireFilter(initialFilterState(), null, 100)
    expect(wire.severity).toBeUndefined()
    expect(wire.kind).toBeUndefined()
    expect(wire.phase).toBeUndefined()
    expect(wire.since).toBeUndefined()
    expect(wire.taskId).toBeUndefined()
    expect(wire.originId).toBeUndefined()
    expect(wire.q).toBeUndefined()
    expect(wire.limit).toBe(100)
  })

  it('encodes `since` from the time range', () => {
    const state = { ...initialFilterState(), range: '1h' as const }
    const wire = toWireFilter(state, null, 100)
    expect(wire.since).toBeDefined()
    expect(new Date(wire.since!).getTime()).toBeLessThan(Date.now())
  })

  it('passes the reduced kind multi-select through', () => {
    const state = {
      ...initialFilterState(),
      kinds: new Set(['task_failed' as const]),
    }
    const wire = toWireFilter(state, null, 100)
    expect(wire.kind).toEqual(['task_failed'])
  })

  it('passes the reduced severity multi-select through', () => {
    const state = {
      ...initialFilterState(),
      severities: new Set(['error' as const]),
    }
    const wire = toWireFilter(state, null, 100)
    expect(wire.severity).toEqual(['error'])
  })

  it('strips the synthetic (n/a) phase before reaching the wire', () => {
    const state = {
      ...initialFilterState(),
      phases: new Set(['verify' as const, '(n/a)' as const]),
    }
    const wire = toWireFilter(state, null, 100)
    expect(wire.phase).toEqual(['verify'])
  })

  it('passes taskId, originId, q through verbatim', () => {
    const state = {
      ...initialFilterState(),
      taskId: 't-1',
      originId: 'prop-x',
      q: 'verify',
    }
    const wire = toWireFilter(state, null, 100)
    expect(wire.taskId).toBe('t-1')
    expect(wire.originId).toBe('prop-x')
    expect(wire.q).toBe('verify')
  })

  it('appends a cursor for paginated requests', () => {
    const wire = toWireFilter(initialFilterState(), 'opaque', 100)
    expect(wire.cursor).toBe('opaque')
  })
})

describe('sinceFromRange', () => {
  it('returns undefined for "all"', () => {
    expect(sinceFromRange('all')).toBeUndefined()
  })

  it('returns an ISO string in the past for "15m"', () => {
    const now = Date.now()
    const iso = sinceFromRange('15m', now)
    expect(iso).toBeDefined()
    expect(new Date(iso!).getTime()).toBe(now - TIME_RANGE_MS['15m'])
  })
})

describe('applyLocalPhaseFilter', () => {
  it('returns the input untouched when every phase is selected', () => {
    const events = [makeEvent({ phase: 'verify' }), makeEvent({ id: 'ev-2', phase: null })]
    const out = applyLocalPhaseFilter(events, new Set(PHASE_OPTIONS))
    expect(out).toHaveLength(2)
  })

  it('drops events whose phase is not in the selection', () => {
    const events = [
      makeEvent({ id: 'a', phase: 'verify' }),
      makeEvent({ id: 'b', phase: 'code' }),
    ]
    const out = applyLocalPhaseFilter(events, new Set(['verify' as const]))
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('a')
  })

  it('honours the synthetic (n/a) phase for null-phase events', () => {
    const events = [
      makeEvent({ id: 'a', phase: 'verify' }),
      makeEvent({ id: 'b', phase: null }),
    ]
    const phasesWithNa = new Set<'verify' | '(n/a)'>(['verify', '(n/a)'])
    const out = applyLocalPhaseFilter(events, phasesWithNa)
    expect(out).toHaveLength(2)

    const phasesWithoutNa = new Set<'verify'>(['verify'])
    const out2 = applyLocalPhaseFilter(events, phasesWithoutNa)
    expect(out2).toHaveLength(1)
    expect(out2[0].id).toBe('a')
  })
})

describe('KIND_OPTIONS vocabulary', () => {
  it('matches the daemon TRACE_EVENT_KINDS list', () => {
    expect(KIND_OPTIONS).toEqual([
      'origin_created',
      'step_started',
      'step_ended',
      'tool_invoked',
      'task_blocked',
      'recovery_spawned',
      'task_failed',
    ])
  })

  it('exposes the three severity levels', () => {
    expect(SEVERITY_OPTIONS).toEqual(['info', 'warn', 'error'])
  })
})

// ---------------------------------------------------------------------------
// 2. Render-snapshot tests
// ---------------------------------------------------------------------------

describe('EventsPage render', () => {
  it('renders the empty-state line when the response has no events', () => {
    const qc = makeClient(EMPTY_RESPONSE)
    const html = renderPage(qc)
    expect(html).toContain('No events match the current filters.')
  })

  it('renders one row per event with the severity badge and a #/task/<id> link', () => {
    const qc = makeClient(makeResponse([makeEvent({ taskId: 't-abc' })]))
    const html = renderPage(qc)
    expect(html).toContain('[error]')
    expect(html).toContain('task_failed')
    expect(html).toContain('verify:typecheck')
    // Click affordance — the row is wrapped in an anchor to the task drawer.
    expect(html).toContain('href="#/task/t-abc"')
  })

  it('renders rows without an anchor when the event has no taskId', () => {
    const qc = makeClient(
      makeResponse([
        makeEvent({
          id: 'ev-no-task',
          taskId: null,
          kind: 'origin_created',
          phase: null,
          severity: 'info',
          payload: { source: 'planner' },
        }),
      ]),
    )
    const html = renderPage(qc)
    // The row renders, but there is no anchor for a null-taskId event.
    expect(html).toContain('data-testid="event-row-ev-no-task"')
    expect(html).not.toContain('href="#/task/')
  })

  it('renders a Refresh button in the header', () => {
    const qc = makeClient(EMPTY_RESPONSE)
    const html = renderPage(qc)
    expect(html).toContain('data-testid="events-refresh"')
    expect(html).toContain('Refresh')
  })

  it('renders all six filter controls (time/severity/kind/phase/task id/origin id/q)', () => {
    const qc = makeClient(EMPTY_RESPONSE)
    const html = renderPage(qc)
    expect(html).toContain('data-testid="events-time-range"')
    expect(html).toContain('data-testid="events-severity"')
    expect(html).toContain('data-testid="events-kind"')
    expect(html).toContain('data-testid="events-phase"')
    expect(html).toContain('data-testid="events-task-id"')
    expect(html).toContain('data-testid="events-origin-id"')
    expect(html).toContain('data-testid="events-q"')
  })

  it('shows the Load more button when nextCursor is non-null and there are events', () => {
    const qc = makeClient(
      makeResponse([makeEvent()], 'opaque-cursor'),
    )
    const html = renderPage(qc)
    expect(html).toContain('data-testid="events-load-more"')
    expect(html).toContain('Load more')
  })

  it('hides Load more when nextCursor is null', () => {
    const qc = makeClient(makeResponse([makeEvent()], null))
    const html = renderPage(qc)
    expect(html).not.toContain('data-testid="events-load-more"')
  })
})

// ---------------------------------------------------------------------------
// 3. Network shape — fetchEvents is called with the wire filter we built.
//
// Render-side mounting won't trigger queryFn under renderToStaticMarkup
// (no client effects). Instead we exercise the wire layer directly: the
// queryFn handed to React Query is just `fetchEvents(toWireFilter(state))`,
// so verifying the URL fetchEvents emits with each state shape gives us
// the same coverage with no rendering required.
// ---------------------------------------------------------------------------

const { fetchEvents } = await import('@/shared/api')

describe('fetchEvents URL shape via toWireFilter', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(EMPTY_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('default state issues a /api/trace-events GET with limit only', async () => {
    await fetchEvents(toWireFilter(initialFilterState(), null, 100))
    const url = fetchSpy.mock.calls[0]![0] as string
    expect(url).toContain('/api/trace-events')
    expect(url).toContain('limit=100')
    expect(url).not.toContain('kind=')
    expect(url).not.toContain('severity=')
    expect(url).not.toContain('phase=')
    expect(url).not.toContain('since=')
    expect(url).not.toContain('taskId=')
    expect(url).not.toContain('originId=')
    expect(url).not.toContain('q=')
  })

  it('reducing severity to {error} narrows the URL to severity=error', async () => {
    const state = {
      ...initialFilterState(),
      severities: new Set(['error' as const]),
    }
    await fetchEvents(toWireFilter(state, null, 100))
    const url = fetchSpy.mock.calls[0]![0] as string
    expect(url).toContain('severity=error')
  })

  it('reducing kind to {task_failed} narrows the URL to kind=task_failed', async () => {
    const state = {
      ...initialFilterState(),
      kinds: new Set(['task_failed' as const]),
    }
    await fetchEvents(toWireFilter(state, null, 100))
    const url = fetchSpy.mock.calls[0]![0] as string
    expect(url).toContain('kind=task_failed')
  })

  it('a time range adds a `since` ISO param', async () => {
    const state = { ...initialFilterState(), range: '15m' as const }
    await fetchEvents(toWireFilter(state, null, 100))
    const url = fetchSpy.mock.calls[0]![0] as string
    expect(url).toContain('since=')
  })

  it('the q input is passed through to the endpoint', async () => {
    const state = { ...initialFilterState(), q: 'merge-conflict' }
    await fetchEvents(toWireFilter(state, null, 100))
    const url = fetchSpy.mock.calls[0]![0] as string
    expect(url).toContain('q=merge-conflict')
  })

  it('a non-null cursor appends cursor= to the URL for Load more requests', async () => {
    await fetchEvents(toWireFilter(initialFilterState(), 'opaque', 100))
    const url = fetchSpy.mock.calls[0]![0] as string
    expect(url).toContain('cursor=opaque')
  })
})

// Silence the unused-binding lint warning for mock — bun:test pulls it via the
// module-level import but the helper functions below don't reference it.
void mock
