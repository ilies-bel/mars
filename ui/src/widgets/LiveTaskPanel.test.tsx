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

import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '@/shared/schemas'

// ── Mutable state shared across tests ────────────────────────────────────────
// The mock factory closes over these variables; each test updates them before
// calling renderToStaticMarkup so the mock returns the right data.

let liveQueryData: unknown = null
let liveQueryPending = false
let liveQueryError = false

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
  useQuery: (opts: { queryKey: unknown[] }) => {
    const key = opts.queryKey as unknown[]
    // Live-task query key: ['task', id, 'live']
    if (Array.isArray(key) && key[2] === 'live') {
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
