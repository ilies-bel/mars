// @vitest-environment happy-dom
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
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { vi } from 'vitest'
import type { EventsResponse, TraceEvent } from '@/shared/schemas'
import { logFallbackError } from '@/shared/uiFallback'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 45,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      key: index,
      index,
      start: index * 45,
    })),
  }),
}))

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
  groupConsecutiveEvents,
} = __test__

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeEvent = (overrides: Partial<TraceEvent> = {}): TraceEvent => ({
  id: 'ev-1',
  timestamp: Date.now(),
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
// The null is the projectId slot — the EventsPage reads the focused project
// from FocusedProjectContext, which defaults to null when there is no provider
// (as in these tests). The key must mirror the shape the component produces.
const QUERY_KEY_FOR = (state = initialFilterState()): unknown[] => [
  'events-page',
  null, // projectId — null when rendered outside FocusedProjectProvider
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
  it('matches the daemon TRACE_EVENT_KINDS list (including log_line)', () => {
    expect(KIND_OPTIONS).toEqual([
      'origin_created',
      'step_started',
      'step_ended',
      'tool_invoked',
      'task_blocked',
      'recovery_spawned',
      'task_failed',
      'log_line',
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
    expect(html).toContain('No events match these filters.')
  })

  it('renders one row per event with the severity badge and a #/task/<id>?from=events link', () => {
    const qc = makeClient(makeResponse([makeEvent({ taskId: 't-abc' })]))
    const html = renderPage(qc)
    expect(html).toContain('error')
    expect(html).toContain('Failed')
    // summarizeTraceEvent humanises the raw code: 'verify:typecheck' → 'typecheck (verify step)'
    expect(html).toContain('typecheck (verify step)')
    // The task-id chip links to the task drawer, tagged with from=events so
    // closing the drawer returns to the Events page.
    expect(html).toContain('href="#/task/t-abc?from=events"')
  })

  it('routes rows and task chips to their separate destinations without nested links', () => {
    const qc = makeClient(
      makeResponse([
        makeEvent({
          id: 'ev-separate-targets',
          taskId: 't-separate',
          kind: 'step_started',
          phase: 'code',
          payload: { stepName: 'code' },
        }),
        makeEvent({
          id: 'ev-step-ended',
          taskId: 't-ended',
          kind: 'step_ended',
          phase: 'verify',
          payload: { stepName: 'verify' },
        }),
      ]),
    )
    const container = document.createElement('div')
    const root = createRoot(container)
    document.body.appendChild(container)
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <EventsPage />
        </QueryClientProvider>,
      )
    })

    const codeRow = container.querySelector<HTMLElement>('[data-testid="event-row-ev-separate-targets"]')!
    const verifyRow = container.querySelector<HTMLElement>('[data-testid="event-row-ev-step-ended"]')!
    const taskChip = codeRow.querySelector<HTMLAnchorElement>('a')!

    expect(codeRow.getAttribute('role')).toBe('link')
    expect(codeRow.tabIndex).toBe(0)
    expect(codeRow.querySelectorAll('a')).toHaveLength(1)
    expect(taskChip.getAttribute('href')).toBe('#/task/t-separate?from=events')

    act(() => {
      codeRow.click()
    })
    expect(window.location.hash).toBe('#/task/t-separate?from=events&step=code')

    act(() => {
      verifyRow.click()
    })
    expect(window.location.hash).toBe('#/task/t-ended?from=events&step=verify')

    act(() => {
      taskChip.click()
    })
    expect(window.location.hash).toBe('#/task/t-separate?from=events')

    act(() => {
      codeRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(window.location.hash).toBe('#/task/t-separate?from=events&step=code')

    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('does not include step= for non-step events (only from= is present)', () => {
    const qc = makeClient(makeResponse([makeEvent({ taskId: 't-other', kind: 'task_failed' })]))
    const html = renderPage(qc)
    expect(html).toContain('href="#/task/t-other?from=events"')
    expect(html).not.toContain('step=')
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

  it('renders category labels (Severity, Kind, Phase) as non-interactive spans — not buttons', () => {
    // The Severity:, Kind:, Phase: labels must be informational read-only spans.
    // CSS text-transform:uppercase makes them visually all-caps but the DOM text
    // stays in the prop's original mixed case. Users click the pill *buttons* to
    // toggle filters; they never click labels.
    // This verifies the label/pill distinction is preserved at the semantic level.
    const qc = makeClient(EMPTY_RESPONSE)
    const html = renderPage(qc)
    // Each label appears as plain text in the HTML — not wrapped in a <button>.
    expect(html).toContain('>Severity:<')
    expect(html).toContain('>Kind:<')
    expect(html).toContain('>Phase:<')
    // The pill buttons carry aria-pressed; the labels must NOT carry aria-pressed.
    // Count occurrences: one aria-pressed per pill (3 severities + 8 kinds + 5 phases = 16).
    const pillCount = (html.match(/aria-pressed=/g) ?? []).length
    expect(pillCount).toBe(SEVERITY_OPTIONS.length + KIND_OPTIONS.length + PHASE_OPTIONS.length)
  })

  it('renders thin visual separators between the SEVERITY, KIND, and PHASE pill groups', () => {
    // The filter bar splits its three pill groups with decorative dividers so
    // operators can distinguish them at a glance without relying on label text alone.
    // Separators are aria-hidden so assistive technology skips them.
    const qc = makeClient(EMPTY_RESPONSE)
    const html = renderPage(qc)
    // There are 3 separators: (time|SEVERITY), (SEVERITY|KIND), (PHASE|inputs).
    const separatorCount = (html.match(/aria-hidden="true"/g) ?? []).length
    expect(separatorCount).toBeGreaterThanOrEqual(3)
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

  // ---------------------------------------------------------------------------
  // Staleness-visibility: fetched-at chip
  //
  // The Events page must never look silently fresh when it is actually stale.
  // A "fetched … ago" chip in the header is the minimum signal we require.
  // Tests use renderToStaticMarkup so useEffect (the interval) does not run;
  // we verify the chip appears on the initial render driven by dataUpdatedAt.
  // ---------------------------------------------------------------------------

  it('shows a fetched-at chip in the header when data is in cache', () => {
    // makeClient calls setQueryData which stamps dataUpdatedAt = Date.now().
    // The chip must appear so the operator can see when the stream was last fetched.
    const qc = makeClient(EMPTY_RESPONSE)
    const html = renderPage(qc)
    expect(html).toContain('data-testid="events-fetched-at"')
    expect(html).toContain('fetched')
  })

  it('fetched-at chip reads "fetched just now" for data loaded within the last minute', () => {
    // setQueryData timestamps dataUpdatedAt ≈ Date.now(); the component's `now`
    // state is also initialised to Date.now() at render time. Age < 60s →
    // formatRelativeAge returns "just now".
    const qc = makeClient(EMPTY_RESPONSE)
    const html = renderPage(qc)
    expect(html).toContain('fetched just now')
  })

  it('event row shows elapsed relative time computed at render (not a stale constant)', () => {
    // Create an event whose timestamp is exactly 5 minutes in the past.
    // relativeTime(timestamp, now) must produce "5m ago" — confirming that
    // the current `now` (≈ Date.now()) is passed into the timestamp computation
    // rather than some earlier frozen value.
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
    const qc = makeClient(makeResponse([makeEvent({ id: 'ev-tick', timestamp: fiveMinutesAgo })]))
    const html = renderPage(qc)
    expect(html).toContain('5m ago')
  })
})

// ---------------------------------------------------------------------------
// 2a. log_line event rendering
// ---------------------------------------------------------------------------

describe('EventRow log_line rendering', () => {
  it('renders payload.msg as the row body', () => {
    const qc = makeClient(
      makeResponse([
        makeEvent({
          id: 'ev-log',
          kind: 'log_line',
          severity: 'info',
          taskId: null,
          phase: null,
          payload: { level: 'info', msg: 'daemon started', source: 'daemon' },
        }),
      ]),
    )
    const html = renderPage(qc)
    expect(html).toContain('daemon started')
  })

  it('renders payload.source as a tag', () => {
    const qc = makeClient(
      makeResponse([
        makeEvent({
          id: 'ev-log-src',
          kind: 'log_line',
          severity: 'warn',
          taskId: null,
          phase: null,
          payload: { level: 'warn', msg: 'slow query', source: 'workflow' },
        }),
      ]),
    )
    const html = renderPage(qc)
    // The source tag carries a data-testid so it can be identified distinctly.
    expect(html).toContain('data-testid="event-row-source-ev-log-src"')
    expect(html).toContain('workflow')
  })

  it('severity color is driven by the stored severity (derived from payload.level)', () => {
    const qc = makeClient(
      makeResponse([
        makeEvent({
          id: 'ev-log-err',
          kind: 'log_line',
          severity: 'error',
          taskId: null,
          phase: null,
          payload: { level: 'error', msg: 'fatal error', source: 'daemon' },
        }),
      ]),
    )
    const html = renderPage(qc)
    // Error severity → row tinting and badge styling from severityRowClass / severityColor.
    expect(html).toContain('border-error/40')
    expect(html).toContain('bg-error/5')
  })

  it('shows a fields toggle button when payload.fields is non-empty', () => {
    const qc = makeClient(
      makeResponse([
        makeEvent({
          id: 'ev-log-fields',
          kind: 'log_line',
          severity: 'info',
          taskId: null,
          phase: null,
          payload: {
            level: 'info',
            msg: 'task queued',
            source: 'bus',
            fields: { taskId: 'mars-abc', retries: 2 },
          },
        }),
      ]),
    )
    const html = renderPage(qc)
    expect(html).toContain('data-testid="event-row-fields-toggle-ev-log-fields"')
    expect(html).toContain('fields')
  })

  it('does not show the expanded fields panel on initial render (page-level expansion state starts empty)', () => {
    // The fix lifts expansion state from row-local useState to a page-level
    // Set<string> keyed by event id. Because the Set starts empty, the panel
    // is collapsed on first render — consistent with the old behaviour — but
    // now a virtualizer row that unmounts and re-mounts receives the same Set
    // entry and re-renders expanded rather than resetting to false.
    const qc = makeClient(
      makeResponse([
        makeEvent({
          id: 'ev-persist-check',
          kind: 'log_line',
          severity: 'info',
          taskId: null,
          phase: null,
          payload: {
            level: 'info',
            msg: 'task queued',
            source: 'bus',
            fields: { taskId: 'mars-abc', retries: 2 },
          },
        }),
      ]),
    )
    const html = renderPage(qc)
    // Toggle button is present (fields are available to expand)
    expect(html).toContain('data-testid="event-row-fields-toggle-ev-persist-check"')
    // Panel is NOT rendered on initial mount — Set starts empty
    expect(html).not.toContain('data-testid="event-row-fields-ev-persist-check"')
    // Button label is "fields" (collapsed state), not "hide fields" (expanded state)
    expect(html).toContain('>fields<')
    expect(html).not.toContain('hide fields')
  })

  it('omits the fields toggle when payload.fields is absent', () => {
    const qc = makeClient(
      makeResponse([
        makeEvent({
          id: 'ev-log-nofields',
          kind: 'log_line',
          severity: 'info',
          taskId: null,
          phase: null,
          payload: { level: 'info', msg: 'heartbeat', source: 'daemon' },
        }),
      ]),
    )
    const html = renderPage(qc)
    expect(html).not.toContain('data-testid="event-row-fields-toggle-ev-log-nofields"')
  })

  it('toWireFilter passes log_line through when only log_line is selected', () => {
    const state = {
      ...initialFilterState(),
      kinds: new Set(['log_line' as const]),
    }
    const wire = toWireFilter(state, null, 100)
    expect(wire.kind).toEqual(['log_line'])
  })

  it('toWireFilter omits kind filter when all kinds including log_line are selected', () => {
    // Default state now includes log_line — all selected means no filter.
    const wire = toWireFilter(initialFilterState(), null, 100)
    expect(wire.kind).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2b. EventRow severity-based visual weight
//
// WARN/ERROR rows must be visually distinct from INFO rows via both a
// colour-derived border/background tint AND a non-colour cue (font weight).
// INFO rows must stay calm — no error/warn tinting.
// ---------------------------------------------------------------------------

describe('EventRow severity styling', () => {
  it('ERROR row has error-tinted border and background', () => {
    const qc = makeClient(
      makeResponse([makeEvent({ id: 'ev-err', severity: 'error', taskId: null })]),
    )
    const html = renderPage(qc)
    expect(html).toContain('border-error/40')
    expect(html).toContain('bg-error/5')
  })

  it('WARN row has warn-tinted border and background', () => {
    const qc = makeClient(
      makeResponse([
        makeEvent({
          id: 'ev-warn',
          severity: 'warn',
          kind: 'task_blocked',
          taskId: null,
          payload: {},
        }),
      ]),
    )
    const html = renderPage(qc)
    expect(html).toContain('border-warn/40')
    expect(html).toContain('bg-warn/5')
  })

  it('INFO row keeps calm neutral styling and has no error/warn tinting', () => {
    const qc = makeClient(
      makeResponse([
        makeEvent({
          id: 'ev-info',
          severity: 'info',
          kind: 'origin_created',
          taskId: null,
          phase: null,
          payload: { source: 'planner' },
        }),
      ]),
    )
    const html = renderPage(qc)
    expect(html).toContain('border-primary/30')
    expect(html).toContain('bg-primary/5')
    expect(html).not.toContain('border-error')
    expect(html).not.toContain('border-warn')
  })

  it('WARN/ERROR severity badge is font-semibold (non-colour weight cue)', () => {
    const warnQc = makeClient(
      makeResponse([
        makeEvent({
          id: 'ev-warn-bold',
          severity: 'warn',
          kind: 'task_blocked',
          taskId: null,
          payload: {},
        }),
      ]),
    )
    const warnHtml = renderPage(warnQc)
    // The [warn] badge must carry a weight cue so severity is not signalled
    // by colour alone (accessibility requirement).
    expect(warnHtml).toContain('font-semibold')

    const errQc = makeClient(
      makeResponse([makeEvent({ id: 'ev-err-bold', severity: 'error', taskId: null })]),
    )
    const errHtml = renderPage(errQc)
    expect(errHtml).toContain('font-semibold')
  })

  it('INFO severity badge is NOT font-semibold (stays visually quiet)', () => {
    const qc = makeClient(
      makeResponse([
        makeEvent({
          id: 'ev-info-quiet',
          severity: 'info',
          kind: 'origin_created',
          taskId: null,
          phase: null,
          payload: { source: 'planner' },
        }),
      ]),
    )
    const html = renderPage(qc)
    expect(html).not.toContain('font-semibold')
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

// ---------------------------------------------------------------------------
// 3b. Debounce / keepPreviousData — filter-change UX
//
// These tests verify that:
//   - Events stay visible during a background refetch (keepPreviousData: the
//     list must NOT be replaced by "Loading events…" when data is being refreshed
//     in the background — status='success' + fetchStatus='fetching' is the exact
//     state that placeholderData:keepPreviousData produces after a filter change).
//   - The component does NOT render "Loading events…" when query status is
//     'success' regardless of fetchStatus — the gate uses isPending (status===
//     'pending'), not isFetching.
// ---------------------------------------------------------------------------

describe('EventsPage debounce / keepPreviousData', () => {
  it('does not show "Loading events…" when query is success but still fetching in background', () => {
    // Construct the QueryClient state that placeholderData: keepPreviousData
    // produces after a filter change: status='success', data=previous events,
    // fetchStatus='fetching' (new request in-flight).
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    const query = qc.getQueryCache().build(qc, { queryKey: QUERY_KEY_FOR() })
    query.setState({
      status: 'success',
      data: makeResponse([makeEvent({ id: 'ev-keep' })]),
      fetchStatus: 'fetching',
    })
    const html = renderPage(qc)
    // Must show events — NOT the loading placeholder
    expect(html).not.toContain('Loading events…')
    expect(html).toContain('data-testid="event-row-ev-keep"')
  })

  it('shows "Loading events…" only when there is genuinely no data yet (status=pending)', () => {
    // Construct the QueryClient state that represents a brand-new query that
    // has never resolved. keepPreviousData cannot help here — there is no
    // prior data to hold onto.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    const query = qc.getQueryCache().build(qc, { queryKey: QUERY_KEY_FOR() })
    query.setState({ status: 'pending', fetchStatus: 'fetching', data: undefined })
    const html = renderPage(qc)
    expect(html).toContain('Loading events…')
  })
})

// ---------------------------------------------------------------------------
// 4. Error-state fallback copy — prod vs dev mode
//
// These tests verify that the EventsPage error branch:
//   - Routes through getFallbackCopy so no hard-coded 'Failed to load events'
//     appears in prod output.
//   - Renders the raw diagnostic detail only in dev mode.
//   - Calls logFallbackError (which calls console.error) only in dev mode.
//
// Since renderToStaticMarkup is synchronous, useEffect does not run.
// The console.error assertion therefore calls logFallbackError directly —
// the same pattern used in ApiErrorPanel.test.tsx.
// ---------------------------------------------------------------------------

const makeErrorClient = (error: Error): QueryClient => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  const query = qc.getQueryCache().build(qc, { queryKey: QUERY_KEY_FOR() })
  query.setState({ status: 'error', error, fetchStatus: 'idle' })
  return qc
}

// These three cases were skipped as "vi.stubEnv is not available in bun".
// That premise was never true for this file: EventsPage.test.tsx lives under
// ui/src/, which runs on vitest (see vitest.config.ts), not on bun — only
// ui/server/ has a Bun-native half. vitest implements vi.stubEnv, and
// logFallbackError reads import.meta.env.DEV at CALL time, not at module eval,
// so the prod branch is reachable with a per-test stub.
describe('EventsPage error state', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('renders the warm fallback headline', () => {
    const html = renderPage(makeErrorClient(new Error('Connection refused')))
    // renderToStaticMarkup HTML-encodes apostrophes; match the encoded form.
    expect(html).toContain("Couldn&#x27;t load the events stream.")
  })

  it('does not call console.error in prod mode', () => {
    vi.stubEnv('DEV', false)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // logFallbackError only calls console.error in DEV mode; in prod it is a
    // no-op so end-users never see diagnostics.
    logFallbackError(new Error('Connection refused'))
    expect(spy).not.toHaveBeenCalled()
  })

  it('renders the raw error detail in dev mode', () => {
    const html = renderPage(makeErrorClient(new Error('Connection refused')))
    // stringifyError() in shared/uiFallback.ts returns `error.message`, not the
    // `Error: <message>` toString form — the skipped version of this test
    // asserted the latter and would have failed the day it was re-enabled.
    expect(html).toContain('Connection refused')
    // The dev-only remedy line accompanies the detail; in prod both are null.
    expect(html).toContain('Reload the page')
  })

  it('calls console.error once in dev mode', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logFallbackError(new Error('Connection refused'))
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 5. groupConsecutiveEvents — pure grouping function
// ---------------------------------------------------------------------------

describe('groupConsecutiveEvents', () => {
  it('returns an empty array for empty input', () => {
    expect(groupConsecutiveEvents([])).toEqual([])
  })

  it('treats a run of exactly one event as a single row, never a group', () => {
    const events = [makeEvent({ id: 'only', payload: { msg: 'solo' } })]
    const rows = groupConsecutiveEvents(events)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ type: 'single', event: events[0] })
  })

  it('collapses exactly two consecutive identical-payload events into one group (minimum group size)', () => {
    const payload = { msg: 'statusline' }
    const events = [
      makeEvent({ id: 'pair-a', payload }),
      makeEvent({ id: 'pair-b', payload }),
    ]
    const rows = groupConsecutiveEvents(events)
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('group')
    if (rows[0].type === 'group') {
      expect(rows[0].events).toHaveLength(2)
      expect(rows[0].events[0].id).toBe('pair-a')
      expect(rows[0].events[1].id).toBe('pair-b')
    }
  })

  it('wraps each non-duplicate event as a single row when all payloads differ', () => {
    const events = [
      makeEvent({ id: 'a', payload: { x: 1 } }),
      makeEvent({ id: 'b', payload: { x: 2 } }),
    ]
    const rows = groupConsecutiveEvents(events)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ type: 'single', event: events[0] })
    expect(rows[1]).toEqual({ type: 'single', event: events[1] })
  })

  it('collapses consecutive identical-payload events into one group row', () => {
    const payload = { msg: 'mars statusline', source: 'daemon' }
    const events = [
      makeEvent({ id: 'a', payload }),
      makeEvent({ id: 'b', payload }),
      makeEvent({ id: 'c', payload }),
    ]
    const rows = groupConsecutiveEvents(events)
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('group')
    if (rows[0].type === 'group') expect(rows[0].events).toHaveLength(3)
  })

  it('does not merge non-consecutive identical payloads (they are separated by a different event)', () => {
    const payload = { msg: 'statusline' }
    const events = [
      makeEvent({ id: 'a', payload }),
      makeEvent({ id: 'b', payload: { msg: 'other' } }),
      makeEvent({ id: 'c', payload }),
    ]
    const rows = groupConsecutiveEvents(events)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ type: 'single', event: events[0] })
    expect(rows[1]).toEqual({ type: 'single', event: events[1] })
    expect(rows[2]).toEqual({ type: 'single', event: events[2] })
  })

  it('does not merge events that share kind but have different payloads', () => {
    const events = [
      makeEvent({ id: 'a', kind: 'log_line', payload: { msg: 'line A' } }),
      makeEvent({ id: 'b', kind: 'log_line', payload: { msg: 'line B' } }),
    ]
    const rows = groupConsecutiveEvents(events)
    expect(rows).toHaveLength(2)
    expect(rows[0].type).toBe('single')
    expect(rows[1].type).toBe('single')
  })

  it('produces correct groups for a mixed run: single + group + single', () => {
    const repeatedPayload = { msg: 'statusline' }
    const events = [
      makeEvent({ id: 'solo-1', payload: { msg: 'unique' } }),
      makeEvent({ id: 'g1', payload: repeatedPayload }),
      makeEvent({ id: 'g2', payload: repeatedPayload }),
      makeEvent({ id: 'solo-2', payload: { msg: 'also unique' } }),
    ]
    const rows = groupConsecutiveEvents(events)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ type: 'single', event: events[0] })
    expect(rows[1].type).toBe('group')
    if (rows[1].type === 'group') {
      expect(rows[1].events).toHaveLength(2)
      expect(rows[1].events[0].id).toBe('g1')
    }
    expect(rows[2]).toEqual({ type: 'single', event: events[3] })
  })
})

// ---------------------------------------------------------------------------
// 5a. EventsPage — consecutive event grouping (render)
// ---------------------------------------------------------------------------

describe('EventsPage — consecutive identical event grouping', () => {
  it('collapses N consecutive identical-payload events into a single row showing ×N count', () => {
    const payload = { msg: 'mars statusline', source: 'daemon' }
    const events = [
      makeEvent({ id: 'ev-g1', payload }),
      makeEvent({ id: 'ev-g2', payload }),
      makeEvent({ id: 'ev-g3', payload }),
    ]
    const qc = makeClient(makeResponse(events))
    const html = renderPage(qc)
    // Count badge present
    expect(html).toContain('×3')
    // Group row testid uses the first event id
    expect(html).toContain('data-testid="group-row-ev-g1"')
    // Individual event rows NOT rendered in collapsed state
    expect(html).not.toContain('data-testid="event-row-ev-g1"')
    expect(html).not.toContain('data-testid="event-row-ev-g2"')
    expect(html).not.toContain('data-testid="event-row-ev-g3"')
  })

  it('shows a time range spanning the first and last event timestamp in the grouped row', () => {
    const payload = { msg: 'mars statusline' }
    const now = Date.now()
    const events = [
      makeEvent({
        id: 'g-first',
        payload,
        timestamp: now - 60 * 1000,
      }),
      makeEvent({
        id: 'g-last',
        payload,
        timestamp: now - 1000,
      }),
    ]
    const qc = makeClient(makeResponse(events))
    const html = renderPage(qc)
    // Both relative timestamps should appear in the collapsed group row
    expect(html).toContain('1m ago')
    expect(html).toContain('1s ago')
  })

  it('keeps individual event rows when payloads differ (no grouping)', () => {
    const events = [
      makeEvent({ id: 'ev-diff-1', payload: { msg: 'alpha' } }),
      makeEvent({ id: 'ev-diff-2', payload: { msg: 'beta' } }),
    ]
    const qc = makeClient(makeResponse(events))
    const html = renderPage(qc)
    expect(html).toContain('data-testid="event-row-ev-diff-1"')
    expect(html).toContain('data-testid="event-row-ev-diff-2"')
    expect(html).not.toContain('×2')
  })

  it('shows the summarized text of the first event inside the collapsed group row', () => {
    // The collapsed GroupedRow renders summarizeTraceEvent(first) as its label.
    // This test verifies that the human-readable summary is present in the DOM
    // so users can identify what the collapsed group represents at a glance.
    const payload = { failureReasonCode: 'verify:typecheck' }
    const events = [
      makeEvent({ id: 'grp-sum-a', kind: 'task_failed', severity: 'error', payload }),
      makeEvent({ id: 'grp-sum-b', kind: 'task_failed', severity: 'error', payload }),
    ]
    const qc = makeClient(makeResponse(events))
    const html = renderPage(qc)
    // Group row exists
    expect(html).toContain('data-testid="group-row-grp-sum-a"')
    // summarizeTraceEvent for task_failed with verify:typecheck → "typecheck (verify step)"
    expect(html).toContain('typecheck (verify step)')
    // Count badge
    expect(html).toContain('×2')
  })
})

// ---------------------------------------------------------------------------
// Timeline view toggle
// ---------------------------------------------------------------------------

describe('EventsPage — timeline view toggle', () => {
  it('renders the flat/timeline toggle buttons', () => {
    const events = [makeEvent({ id: 'ev-toggle-1' })]
    const qc = makeClient(makeResponse(events))
    const html = renderPage(qc)
    expect(html).toContain('data-testid="events-view-flat"')
    expect(html).toContain('data-testid="events-view-timeline"')
  })

  it('defaults to flat view (virtualizer list is rendered)', () => {
    const events = [makeEvent({ id: 'ev-flat-1' })]
    const qc = makeClient(makeResponse(events))
    const html = renderPage(qc)
    // Flat view renders event rows inside the virtualizer
    expect(html).toContain('data-testid="events-list"')
  })
})
