/**
 * LiveTaskPanel — component tests.
 *
 * Coverage:
 *   1. Fixture data with all three sections (step guide, done criteria, notes)
 *      renders correctly; checked and unchecked criteria are visually distinct.
 *   2. Empty notes list shows the "(none)" placeholder.
 *   3. A non-awaiting-human task causes TaskDetailDrawer to omit the panel.
 *
 * Uses renderToStaticMarkup (no real DOM or browser) and mocks useQuery so no
 * running daemon is required.
 *
 * Mock strategy: `mock.module` (mapped to vi.mock by bun-test-compat.ts) is
 * applied to the entire @tanstack/react-query module. The useQuery replacement
 * discriminates on queryKey[2] === 'live' to handle the live-task query; all
 * other queries return an idle-pending stub (safe for static rendering, since
 * missing data just omits optional sections).
 */

import { describe, expect, it, mock, vi } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@/shared/schemas'

// ── Mutable state shared across tests ────────────────────────────────────────
// The mock factory closes over these variables; each test updates them before
// calling renderToStaticMarkup so the mock returns the right data.

let liveQueryData: unknown = null
let liveQueryPending = false
let liveQueryError = false

// Captured queryFn from the last live-task useQuery call. Tests that need to
// simulate React Query invalidation (i.e. a re-fetch triggered by a view-stream
// ping) invoke this directly with a custom fetchImpl and count the calls.
let capturedQueryFn: (() => Promise<unknown>) | undefined

// ── Module-level mock for sonner ──────────────────────────────────────────────
// Prevents DOM errors when EnterSessionButton calls toast.success() in a node
// environment. The toastSuccess reference is captured once the factory runs
// (triggered when LiveTaskPanel is first imported).

let toastSuccess = vi.fn()
mock.module('sonner', () => {
  toastSuccess = vi.fn()
  return { toast: { success: toastSuccess } }
})

// ── Module-level mock for @tanstack/react-query ───────────────────────────────
// Factory is evaluated lazily so closures read the latest variable values when
// useQuery() is actually called during rendering.

mock.module('@tanstack/react-query', () => ({
  // Provide pass-through stubs so tests can render TaskDetailDrawer (which
  // wraps content in a QueryClientProvider) without a real QueryClient.
  QueryClient: class QueryClient {
    defaultOptions = {}
    setDefaultOptions() {}
    getDefaultOptions() { return {} }
  },
  QueryClientProvider: ({ children }: { children: React.ReactNode }) => children,
  useQuery: (opts: { queryKey: unknown[]; queryFn?: () => Promise<unknown> }) => {
    const key = opts.queryKey as unknown[]
    // Live-task query key: ['task', id, 'live']
    if (Array.isArray(key) && key[2] === 'live') {
      // Capture queryFn so tests can invoke it directly to simulate a refetch
      // that React Query would perform after invalidateQueries fires.
      capturedQueryFn = opts.queryFn
      return {
        data: liveQueryData,
        isPending: liveQueryPending,
        isError: liveQueryError,
      }
    }
    // All other queries (task detail, spans, runs, tool events…) return idle-pending.
    return { data: undefined, isPending: true, isError: false }
  },
}))

// Import components AFTER the mock so they see the mocked module.
const { LiveTaskPanel } = await import('./LiveTaskPanel')
const { TaskDetailDrawer } = await import('./TaskDetailDrawer')
const { handleEnterSession } = await import('./EnterSessionButton')

// ── Fixture ───────────────────────────────────────────────────────────────────

const FIXTURE = {
  stepGuide: '## Implement the feature\n\nFollow the spec carefully.',
  doneCriteria: [
    { text: 'Unit tests pass', checked: true },
    { text: 'Types compile', checked: false },
  ],
  notes: [
    { ts: 1_700_000_000_000, text: 'Started implementation' },
    { ts: 1_700_000_001_000, text: 'Tests passing now' },
  ],
}

/** Minimal Task fixture with the given status. */
const makeTask = (status: string): Task =>
  ({
    id: 'mars-test01',
    prompt: 'Test task',
    status,
    plan: null,
    branch: null,
    worktreePath: null,
    error: null,
    dropReason: null,
    recoverySpawnedCount: 0,
    blockedBy: [],
    spec: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }) as unknown as Task

// ── LiveTaskPanel standalone tests ────────────────────────────────────────────

describe('LiveTaskPanel — step guide', () => {
  it('renders the step guide section when present', () => {
    liveQueryData = FIXTURE
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).toContain('data-testid="live-task-panel"')
    expect(html).toContain('data-testid="live-step-guide"')
    expect(html).toContain('Implement the feature')
    expect(html).toContain('Follow the spec carefully.')
  })

  it('omits the step guide section when null', () => {
    liveQueryData = { ...FIXTURE, stepGuide: null }
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).not.toContain('data-testid="live-step-guide"')
    // Rest of the panel still renders.
    expect(html).toContain('data-testid="live-done-criteria"')
  })
})

describe('LiveTaskPanel — done criteria', () => {
  it('renders all criteria with the correct count', () => {
    liveQueryData = FIXTURE
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).toContain('data-testid="live-done-criteria"')
    const count = (html.match(/data-testid="live-criterion"/g) ?? []).length
    expect(count).toBe(2)
    expect(html).toContain('Unit tests pass')
    expect(html).toContain('Types compile')
  })

  it('marks checked criteria with data-checked="true"', () => {
    liveQueryData = FIXTURE
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).toContain('data-checked="true"')
  })

  it('marks unchecked criteria with data-checked="false"', () => {
    liveQueryData = FIXTURE
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).toContain('data-checked="false"')
  })

  it('applies line-through style only to checked criteria', () => {
    liveQueryData = FIXTURE
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    // "line-through" class should appear (checked item); unchecked should not have it.
    expect(html).toContain('line-through')
    // There should be exactly one line-through (one checked criterion).
    const lineThrough = (html.match(/line-through/g) ?? []).length
    expect(lineThrough).toBe(1)
  })
})

describe('LiveTaskPanel — progress journal', () => {
  it('renders notes and orders them newest-first', () => {
    liveQueryData = FIXTURE
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).toContain('data-testid="live-notes"')
    const noteCount = (html.match(/data-testid="live-note"/g) ?? []).length
    expect(noteCount).toBe(2)
    // Newest-first: "Tests passing now" (ts=1_700_000_001_000) appears before "Started"
    expect(html.indexOf('Tests passing now')).toBeLessThan(
      html.indexOf('Started implementation'),
    )
  })

  it('shows the "(none)" placeholder when there are no notes', () => {
    liveQueryData = { ...FIXTURE, notes: [] }
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).toContain('(none)')
    expect(html).not.toContain('data-testid="live-note"')
  })
})

describe('LiveTaskPanel — loading and null states', () => {
  it('shows a loading message while the query is pending', () => {
    liveQueryData = undefined
    liveQueryPending = true
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).toContain('data-testid="live-task-panel"')
    expect(html).toContain('Loading live task')
  })

  it('renders nothing when the query returns null (task not parked)', () => {
    liveQueryData = null
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).not.toContain('data-testid="live-task-panel"')
  })
})

// ── TaskDetailDrawer integration — panel visibility ───────────────────────────
//
// Acceptance criterion 1: the panel only appears when task.status === 'awaiting-human'.
// initialState bypasses the drawer's own task query so the body renders synchronously.

describe('TaskDetailDrawer — live panel visibility by status', () => {
  it('hides the live-task panel for a non-awaiting-human task', () => {
    // Any data in the live query is irrelevant — the panel should not mount.
    liveQueryData = FIXTURE
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="mars-test01"
        onClose={() => {}}
        initialState={{ kind: 'ready', task: makeTask('running') }}
      />,
    )

    expect(html).not.toContain('data-testid="live-task-panel"')
    // Regular drawer body is still present.
    expect(html).toContain('data-testid="task-detail-body"')
  })

  it('shows the live-task panel for an awaiting-human task', () => {
    liveQueryData = FIXTURE
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="mars-test01"
        onClose={() => {}}
        initialState={{ kind: 'ready', task: makeTask('awaiting-human') }}
      />,
    )

    expect(html).toContain('data-testid="live-task-panel"')
    expect(html).toContain('data-testid="task-detail-body"')
  })
})

// ── LiveTaskPanel — auto-refresh contract ─────────────────────────────────────
//
// Consumer slice: "UI: LiveTaskPanel auto-refreshes on view-stream ping".
//
// The panel must pick up fresh data whenever the ['task', taskId, 'live']
// React Query cache entry is invalidated. SseInvalidator fires such
// invalidations on every view-stream ping that touches the task; no explicit
// polling is required. These tests verify that the component re-renders
// correctly whenever the query returns new data — a prerequisite for the
// consumer's invalidation wiring to be meaningful.

describe('LiveTaskPanel — data updates on re-render', () => {
  it('renders updated step guide when mock returns new data (simulates post-ping refetch)', () => {
    liveQueryData = { ...FIXTURE, stepGuide: '## Step A\n\nOriginal guide.' }
    liveQueryPending = false
    liveQueryError = false

    const html1 = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)
    expect(html1).toContain('Original guide.')

    // After SseInvalidator invalidates ['task', taskId, 'live'] and React Query
    // refetches, the component must render the fresh payload immediately.
    liveQueryData = { ...FIXTURE, stepGuide: '## Step B\n\nGuide updated after ping.' }
    const html2 = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)
    expect(html2).toContain('Guide updated after ping.')
    expect(html2).not.toContain('Original guide.')
  })

  it('renders updated note count after a ping delivers a new note', () => {
    liveQueryData = { ...FIXTURE, notes: [{ ts: 1_700_000_000_000, text: 'First note' }] }
    liveQueryPending = false
    liveQueryError = false

    const html1 = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)
    expect((html1.match(/data-testid="live-note"/g) ?? []).length).toBe(1)

    // Ping → invalidate → refetch → second note arrives.
    liveQueryData = {
      ...FIXTURE,
      notes: [
        { ts: 1_700_000_000_000, text: 'First note' },
        { ts: 1_700_000_002_000, text: 'Second note after ping' },
      ],
    }
    const html2 = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)
    expect((html2.match(/data-testid="live-note"/g) ?? []).length).toBe(2)
    expect(html2).toContain('Second note after ping')
  })
})

// ── LiveTaskPanel — enter-session action contract ─────────────────────────────
//
// Consumer slice: "UI: 'Enter session' action on parked task".
//
// When the live-task endpoint returns a worktreePath, the panel renders a
// data-testid="enter-session-btn" action so the operator can jump into the
// agent's working directory for manual inspection without leaving the UI.
//
// Implementation requirements for the consumer slice:
//   • Extend LiveTaskData with `worktreePath?: string | null` in LiveTaskPanel.tsx.
//   • The daemon's GET /view/task/:id/live endpoint must populate worktreePath
//     from task.worktreePath; the UI proxy at GET /api/task/:id/live passes it
//     through unchanged.
//   • The component renders the action only when worktreePath is a non-empty string.

describe('LiveTaskPanel — enter-session action', () => {
  it('renders data-testid="enter-session-btn" when worktreePath is present', () => {
    liveQueryData = {
      ...FIXTURE,
      worktreePath: '/Users/dev/.mars/worktrees/mars-abc12345',
    }
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).toContain('data-testid="enter-session-btn"')
    expect(html).toContain('/Users/dev/.mars/worktrees/mars-abc12345')
  })

  it('omits the enter-session action when worktreePath is null', () => {
    liveQueryData = { ...FIXTURE, worktreePath: null }
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).not.toContain('data-testid="enter-session-btn"')
  })

  it('omits the enter-session action when worktreePath is absent from the payload', () => {
    liveQueryData = FIXTURE
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).not.toContain('data-testid="enter-session-btn"')
  })
})

// ── TaskDetailDrawer — enter-session integration ──────────────────────────────
//
// Consumer slice: "UI: 'Enter session' action on parked task".
//
// The enter-session action must be visible inside the TaskDetailDrawer when the
// task is parked at a manual step (status === 'awaiting-human') and the live
// endpoint returns a worktreePath. For non-parked tasks the panel is not mounted
// so the action never appears.

describe('TaskDetailDrawer — enter-session integration', () => {
  it('exposes the enter-session action for an awaiting-human task with a worktree path', () => {
    liveQueryData = {
      ...FIXTURE,
      worktreePath: '/tmp/mars-test-worktree',
    }
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="mars-test01"
        onClose={() => {}}
        initialState={{ kind: 'ready', task: makeTask('awaiting-human') }}
      />,
    )

    expect(html).toContain('data-testid="enter-session-btn"')
    expect(html).toContain('/tmp/mars-test-worktree')
  })

  it('omits the enter-session action for a non-awaiting-human task even when live data has a worktree path', () => {
    liveQueryData = {
      ...FIXTURE,
      worktreePath: '/tmp/mars-test-worktree',
    }
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="mars-test01"
        onClose={() => {}}
        initialState={{ kind: 'ready', task: makeTask('running') }}
      />,
    )

    // LiveTaskPanel is not mounted for non-awaiting-human tasks.
    expect(html).not.toContain('data-testid="enter-session-btn"')
  })
})

// ── EnterSessionButton — clipboard write ──────────────────────────────────────
//
// Consumer slice: "UI: 'Enter session' action on parked task".
//
// Verifies that handleEnterSession writes the correct `mars enter <id>` command
// to the clipboard and calls the toast helper. Uses a mocked clipboard so the
// test runs in the node environment without a real browser API.

describe('EnterSessionButton — clipboard write and toast', () => {
  it('copies "mars enter <taskId>" to clipboard and calls toast.success', async () => {
    const writeText = vi.fn<[string], Promise<void>>().mockResolvedValue(undefined)
    // In node environment, navigator is not defined — attach a minimal mock.
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      writable: true,
      configurable: true,
    })

    await handleEnterSession('mars-test01')

    expect(writeText).toHaveBeenCalledWith('mars enter mars-test01')
    // toast.success is called after the clipboard write to confirm the action.
    expect(toastSuccess).toHaveBeenCalledOnce()
  })
})

// ── LiveTaskPanel — queryFn fetch count (invalidation contract) ───────────────
//
// The SseInvalidator calls qc.invalidateQueries({ queryKey: ['task', id, 'live'] })
// on every 'live-task' view-stream ping. React Query responds by calling the
// panel's queryFn, which calls fetchImpl. These tests verify that the queryFn
// produced by LiveTaskPanel does in fact call fetchImpl each time it is invoked —
// so two invalidation pings result in two fetches.
//
// Strategy: the module-level useQuery mock captures the queryFn passed by the
// component on each render. Tests invoke the captured fn directly to simulate
// what React Query does on invalidation.

describe('LiveTaskPanel — queryFn calls fetchImpl on each invalidation', () => {
  it('fires fetchImpl twice when the queryFn is invoked twice (two view-stream pings)', async () => {
    liveQueryData = FIXTURE
    liveQueryPending = false
    liveQueryError = false

    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(FIXTURE), { status: 200 }),
      ),
    )

    // Render to let useQuery capture the queryFn that closes over mockFetch.
    renderToStaticMarkup(
      <LiveTaskPanel taskId="mars-test01" fetchImpl={mockFetch as unknown as typeof fetch} />,
    )

    // capturedQueryFn is set by the useQuery mock during the render above.
    expect(capturedQueryFn).toBeDefined()

    // Simulate two back-to-back view-stream 'live-task' pings: React Query
    // would call queryFn once per invalidation when the query is active.
    await capturedQueryFn!()
    await capturedQueryFn!()

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

// ── LiveTaskPanel — merge-gate approve / abort buttons ───────────────────────
//
// Consumer slice: "Make --merge gated approvable from the UI".
//
// When the live-task endpoint returns stepName='merge-gate', the panel must
// render two action buttons:
//   • "Approve and merge" (data-testid="merge-gate-approve-btn")
//   • "Abort without merging" (data-testid="merge-gate-abort-btn")
//
// The confirmation copy must say what will happen in plain words.
// Clicking either button posts to /api/actions with the appropriate op.

describe('LiveTaskPanel — merge-gate buttons', () => {
  it('renders Approve and Abort buttons when stepName is merge-gate', () => {
    liveQueryData = { ...FIXTURE, stepName: 'merge-gate' }
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).toContain('data-testid="merge-gate-actions"')
    expect(html).toContain('data-testid="merge-gate-approve-btn"')
    expect(html).toContain('Approve and merge')
    expect(html).toContain('data-testid="merge-gate-abort-btn"')
    expect(html).toContain('Abort without merging')
  })

  it('includes the confirmation copy with branch and destination', () => {
    liveQueryData = { ...FIXTURE, stepName: 'merge-gate' }
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    // Must mention the task branch and the target ("main") so the operator knows what will happen.
    expect(html).toContain('task/mars-test01')
    expect(html).toContain('main')
  })

  it('omits the merge-gate actions when stepName is not merge-gate', () => {
    liveQueryData = { ...FIXTURE, stepName: 'code' }
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).not.toContain('data-testid="merge-gate-actions"')
    expect(html).not.toContain('data-testid="merge-gate-approve-btn"')
  })

  it('omits the merge-gate actions when stepName is absent', () => {
    liveQueryData = FIXTURE // no stepName
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(<LiveTaskPanel taskId="mars-test01" />)

    expect(html).not.toContain('data-testid="merge-gate-actions"')
  })

  it('renders the Approve button with postActionImpl wired', () => {
    liveQueryData = { ...FIXTURE, stepName: 'merge-gate' }
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(
      <LiveTaskPanel taskId="mars-test01" postActionImpl={() => Promise.resolve()} />,
    )

    expect(html).toContain('data-testid="merge-gate-approve-btn"')
    expect(html).toContain('Approve and merge')
  })

  it('renders the Abort button with postActionImpl wired', () => {
    liveQueryData = { ...FIXTURE, stepName: 'merge-gate' }
    liveQueryPending = false
    liveQueryError = false

    const html = renderToStaticMarkup(
      <LiveTaskPanel taskId="mars-test01" postActionImpl={() => Promise.resolve()} />,
    )

    expect(html).toContain('data-testid="merge-gate-abort-btn"')
    expect(html).toContain('Abort without merging')
  })
})
