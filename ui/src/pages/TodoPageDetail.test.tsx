/**
 * Tests for the actionQueue detail-panel render — the slice-H rewire.
 *
 * Uses a pre-populated QueryClient so the catalog / events / origins
 * useQuery calls resolve synchronously inside renderToStaticMarkup. Pure
 * render-snapshot assertions; the action-button click handlers are not
 * exercised here (they rely on real React event dispatch).
 */
import { afterEach, describe, expect, it, vi } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ActionQueuePage as _Page, ActionQueueRow } from './TodoPage'
import type {
  ActionQueueItem,
  EventsResponse,
  OriginsResponse,
} from '@/shared/schemas'

// Silence the unused-variable lint warning. ActionQueuePage is exported to
// confirm the public surface here even though the tests target the
// sub-components via the panel render.
void _Page

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_EVENTS: EventsResponse = { events: [], nextCursor: null }

const ONE_FAILURE_EVENT: EventsResponse = {
  events: [
    {
      id: 'ev-1',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      kind: 'task_failed',
      severity: 'error',
      taskId: 't-1',
      originId: null,
      phase: 'verify',
      payload: { failureReasonCode: 'verify:typecheck' },
    },
  ],
  nextCursor: null,
}

const SINGLE_NODE_ORIGINS = (taskId: string): OriginsResponse => ({
  node: { id: taskId, kind: 'task', title: 'lone task', status: 'failed', children: [] },
})

const PRD_ORIGINS = (taskId: string): OriginsResponse => ({
  node: {
    id: 'prop-abc',
    kind: 'prd',
    title: 'big feature',
    status: 'sliced',
    children: [
      { id: 'task-sibling', kind: 'task', title: 'slice 1', status: 'done', children: [] },
      { id: taskId, kind: 'task', title: 'slice 2', status: 'failed', children: [] },
    ],
  },
})

const BASE_ITEM: ActionQueueItem = {
  id: 'failed-task:t-1',
  kind: 'failed-task',
  entityId: 't-1',
  priority: 'normal',
  title: 'Some failed task',
  body: 'verbatim body text',
  at: new Date().toISOString(),
  dag: null,
  errorKind: 'failed-task',
  actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
  diagnosis: null,
  failureReasonCode: 'verify:typecheck',
}

// Accepts any field combination so tests can construct cross-variant items
// (e.g. kind:'stale-worktree' + staleWorktreeDetail) without TypeScript
// complaining about union-specific properties.
const makeItem = (overrides: Record<string, unknown>): ActionQueueItem =>
  ({ ...BASE_ITEM, ...overrides } as ActionQueueItem)

// ---------------------------------------------------------------------------
// React Query cache helpers
// ---------------------------------------------------------------------------

/**
 * Build a QueryClient with the catalog, events, and origins responses
 * preloaded so the detail-panel useQuery calls resolve synchronously in
 * renderToStaticMarkup.
 */
const makeClient = (opts: {
  events?: EventsResponse
  origins?: OriginsResponse
  taskId: string
}): QueryClient => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  // The null slot is the projectId from FocusedProjectContext, which defaults
  // to null when rendered outside FocusedProjectProvider (as in these tests).
  qc.setQueryData(['events', null, opts.taskId], opts.events ?? EMPTY_EVENTS)
  qc.setQueryData(
    ['origins', null, opts.taskId],
    opts.origins ?? SINGLE_NODE_ORIGINS(opts.taskId),
  )
  return qc
}

// Snapshot the detail panel by rendering ActionQueueRow's parent component.
// We inline-render the detail panel by going through the public page: we
// can't (easily) export ActionQueueDetail. Instead, the most direct path
// is to import the unexported component. Workaround: render the page with
// the item pre-selected. Cleaner here: just import-as-private from TodoPage.

// We exercise the smaller sub-components by mounting a wrapped fragment.
// The page is structured so the ActionQueueDetail body is the union of
// CatalogReasonAndActions / TracesSection / OriginsSection plus the
// existing Body/Diagnosis blocks. Since those sub-components aren't
// re-exported, we drive the same code path via `renderInPage` below.

// To assert against the detail panel render, mount the page with a single
// item; the selected item drives ActionQueueDetail. The page calls
// useActionQueue, which we stub via a pre-warmed QueryClient too.

const renderDetail = (item: ActionQueueItem, qc: QueryClient): string => {
  qc.setQueryData(['action-queue', null], [item])
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <_Page />
    </QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
// Lightweight sanity: ActionQueueRow still renders (re-export check).
// ---------------------------------------------------------------------------

describe('TodoPage exports', () => {
  it('still exports ActionQueueRow for the sidebar', () => {
    // React.memo wraps the component in an object; verify the export is defined
    // and its underlying type is still a function.
    expect(ActionQueueRow).toBeDefined()
    expect(typeof (ActionQueueRow as { type?: unknown }).type).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// AC1: A failed-task row renders its reason from the row body (ADR-0042),
// which the daemon derived from the signature-keyed Failure kind record.
// The failure reason is now shown prominently in the header (not in a
// separate "Reason" section in the body).
// ---------------------------------------------------------------------------

describe('actionQueue detail – failure reason in header', () => {
  it('renders the row body as the failure reason for a failed-task row', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(BASE_ITEM, qc)
    // Reason text appears in the card (shown in the header section).
    expect(html).toContain('verbatim body text')
  })

  it('renders a different body verbatim for a different row', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(
      makeItem({ body: 'The changes did not pass type-checking.' }),
      qc,
    )
    expect(html).toContain('The changes did not pass type-checking.')
  })

  it('does NOT render a "Reason" section label for any row kind', () => {
    // The "Reason" label was replaced by inline body text in the header.
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(BASE_ITEM, qc)
    expect(html).not.toContain('>Reason<')
  })

  it('does NOT render the failure reason in the header for a stale-worktree row', () => {
    const stale = makeItem({
      kind: 'stale-worktree',
      errorKind: 'stale-worktree',
      actions: [
        { id: 'investigate', label: 'Investigate', op: 'investigate' },
      ],
      // Stale-worktree rows also surface no Origins / Traces section.
      failureReasonCode: null,
      staleWorktreeDetail: {
        prompt: 'some task',
        status: 'running',
        ageHours: 5,
        updatedAt: new Date().toISOString(),
        branch: 'task/t-1',
        empty: false,
        investigation: null,
      },
    })
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(stale, qc)
    // Stale-worktree rows have no "Reason" label and no failure-reason header text.
    expect(html).not.toContain('>Reason<')
  })
})

// ---------------------------------------------------------------------------
// AC2: Recovery actions render as buttons from the row's own `actions` (the
// Failure kind menu), via the shared ActionBar.
// ---------------------------------------------------------------------------

describe('actionQueue detail – Recovery actions', () => {
  it('renders a Restart action button from the row actions', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(BASE_ITEM, qc)
    expect(html).toContain('Recovery')
    // BASE_ITEM carries a single restart action on the row.
    expect(html).toContain('>Restart<')
  })

  it('renders every action the row carries', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(
      makeItem({
        actions: [
          { id: 'diagnose-failure', label: 'Investigate', op: 'diagnose-failure' },
          { id: 'restart', label: 'Restart from scratch', op: 'restart' },
          { id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true },
        ],
      }),
      qc,
    )
    expect(html).toContain('>Investigate<')
    expect(html).toContain('>Restart from scratch<')
    expect(html).toContain('>Drop permanently<')
  })
})

// ---------------------------------------------------------------------------
// AC3: Traces section.
// ---------------------------------------------------------------------------

describe('actionQueue detail – Traces section', () => {
  it('renders trace events with a severity badge', () => {
    const qc = makeClient({
      taskId: 't-1',
      events: ONE_FAILURE_EVENT,
    })
    const html = renderDetail(BASE_ITEM, qc)
    expect(html).toContain('>Traces<')
    // The severity badge for an error event.
    expect(html).toContain('[error]')
    // The summary the event renders (the failure code, per summarizeTraceEvent).
    expect(html).toContain('verify:typecheck')
  })

  it('renders an empty-state line when there are no events', () => {
    const qc = makeClient({ taskId: 't-1', events: EMPTY_EVENTS })
    const html = renderDetail(BASE_ITEM, qc)
    expect(html).toContain('No trace events for this task yet.')
  })
})

// ---------------------------------------------------------------------------
// AC3b: Traces list is bounded inside a scrollable container.
// ---------------------------------------------------------------------------

describe('actionQueue detail – bounded trace scroll', () => {
  it('wraps the trace list in an overflow-y-auto container', () => {
    const qc = makeClient({
      taskId: 't-1',
      events: ONE_FAILURE_EVENT,
    })
    const html = renderDetail(BASE_ITEM, qc)
    expect(html).toContain('overflow-y-auto')
  })
})

// ---------------------------------------------------------------------------
// AC4: Origins section.
// ---------------------------------------------------------------------------

describe('actionQueue detail – Origins section', () => {
  it('renders the proposal-rooted tree and highlights the current task', () => {
    const qc = makeClient({
      taskId: 't-1',
      origins: PRD_ORIGINS('t-1'),
    })
    const html = renderDetail(BASE_ITEM, qc)
    expect(html).toContain('>Origins<')
    // PRD root carries the proposal id.
    expect(html).toContain('prop-abc')
    expect(html).toContain('PRD')
    // Both sibling slices appear.
    expect(html).toContain('task-sibling')
    expect(html).toContain('slice 1')
    expect(html).toContain('slice 2')
    // The current task is the bolded row.
    expect(html).toContain('font-bold')
  })

  it('shows the empty-state line for a single-node tree', () => {
    const qc = makeClient({
      taskId: 't-1',
      origins: SINGLE_NODE_ORIGINS('t-1'),
    })
    const html = renderDetail(BASE_ITEM, qc)
    expect(html).toContain('No origin recorded for this task.')
  })
})

// ---------------------------------------------------------------------------
// AC4b: Origin/recovery navigation — nodes are buttons in the detail card.
// ---------------------------------------------------------------------------

describe('actionQueue detail – origin/recovery navigation', () => {
  it('renders origin-tree nodes as navigable buttons for a failed-task row with siblings', () => {
    const qc = makeClient({
      taskId: 't-1',
      origins: PRD_ORIGINS('t-1'),
    })
    const html = renderDetail(BASE_ITEM, qc)
    // Origin tree is present.
    expect(html).toContain('data-testid="origin-tree"')
    // When onNavigate is wired, OriginNodeRow wraps each node in a button
    // with the 'rounded text-left' class pair — unique to navigation mode.
    expect(html).toContain('rounded text-left')
  })
})

// ---------------------------------------------------------------------------
// Open-task-detail affordance: failed-task rows expose the shared drawer.
// ---------------------------------------------------------------------------

describe('inbox detail – Open task detail affordance', () => {
  it('renders the Open task detail button for a real failed-task row', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(BASE_ITEM, qc)
    expect(html).toContain('data-testid="aq-open-task-detail"')
    expect(html).toContain('Open task detail')
  })

  it('omits the button for the daemon-killed-batch sentinel', () => {
    const qc = makeClient({ taskId: '__daemon-killed-batch__' })
    const html = renderDetail(
      makeItem({
        id: 'failed-task:__daemon-killed-batch__',
        entityId: '__daemon-killed-batch__',
      }),
      qc,
    )
    expect(html).not.toContain('data-testid="aq-open-task-detail"')
  })

  it('omits the button for a stale-worktree row', () => {
    const stale = makeItem({
      kind: 'stale-worktree',
      errorKind: 'stale-worktree',
      actions: [{ id: 'investigate', label: 'Investigate', op: 'investigate' }],
      failureReasonCode: null,
      staleWorktreeDetail: {
        prompt: 'some task',
        status: 'running',
        ageHours: 5,
        updatedAt: new Date().toISOString(),
        branch: 'task/t-1',
        empty: false,
        investigation: null,
      },
    })
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(stale, qc)
    expect(html).not.toContain('data-testid="aq-open-task-detail"')
  })
})

// ---------------------------------------------------------------------------
// Responsive layout: panes must stack on narrow viewports.
// ---------------------------------------------------------------------------

describe('ActionQueuePage – responsive layout', () => {
  it('container switches from column to row at the sm breakpoint', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(BASE_ITEM, qc)
    // flex-col stacks panes on mobile; sm:flex-row restores side-by-side on ≥640px.
    expect(html).toContain('sm:flex-row')
  })

  it('list pane is full-width on mobile and fixed-width on sm+', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(BASE_ITEM, qc)
    // sm:w-80 (320 px) is the desktop list-pane width; w-full is the mobile override.
    expect(html).toContain('sm:w-80')
  })
})

// ---------------------------------------------------------------------------
// Slice-2: Section-level failure fallbacks (catalog / traces / origins)
// Each test stubs DEV=false (prod mode) and seeds the failing query with null
// to trigger the `isError || !data` branch in the relevant component.
// ---------------------------------------------------------------------------

describe('actionQueue detail – trace events fallback (prod)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('shows warm headline and omits "Failed to load" in prod mode', () => {
    vi.stubEnv('DEV', false)
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    // null triggers the `!data` branch for the events query
    qc.setQueryData(['events', null, 't-1'], null)
    qc.setQueryData(['origins', null, 't-1'], SINGLE_NODE_ORIGINS('t-1'))
    qc.setQueryData(['action-queue', null], [BASE_ITEM])
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <_Page />
      </QueryClientProvider>,
    )
    expect(html).toContain("Couldn&#x27;t load the trace events.")
    expect(html).not.toContain('Failed to load')
  })
})

describe('actionQueue detail – origin tasks fallback (prod)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('shows warm headline and omits "Failed to load" in prod mode', () => {
    vi.stubEnv('DEV', false)
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    qc.setQueryData(['events', null, 't-1'], EMPTY_EVENTS)
    // null triggers the `!data` branch for the origins query
    qc.setQueryData(['origins', null, 't-1'], null)
    qc.setQueryData(['action-queue', null], [BASE_ITEM])
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <_Page />
      </QueryClientProvider>,
    )
    expect(html).toContain("Couldn&#x27;t load the origin tasks.")
    expect(html).not.toContain('Failed to load')
  })
})

// ---------------------------------------------------------------------------
// Sidebar grouping: kind-labelled collapsible sections
// Each test renders ActionQueuePage with pre-seeded action-queue cache data
// and verifies the section structure in the HTML output.
// ---------------------------------------------------------------------------

describe('actionQueue sidebar – grouped sections', () => {
  const renderPage = (items: ActionQueueItem[]): string => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    qc.setQueryData(['action-queue', null], items)
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <_Page />
      </QueryClientProvider>,
    )
  }

  it('renders three section headers when all three kinds are present', () => {
    const draft = makeItem({ id: 'd1', kind: 'draft-proposal', errorKind: 'draft-proposal', actions: [] })
    const failed = makeItem({ id: 'f1', kind: 'failed-task', actions: [] })
    const stale = makeItem({
      id: 's1',
      kind: 'stale-worktree',
      errorKind: 'stale-worktree',
      actions: [],
      staleWorktreeDetail: {
        prompt: null,
        status: 'running',
        ageHours: 10,
        updatedAt: new Date().toISOString(),
        branch: 'task/s1',
        empty: true,
        investigation: null,
      },
    })
    const html = renderPage([draft, failed, stale])
    expect(html).toContain('Drafts')
    expect(html).toContain('Failed tasks')
    expect(html).toContain('Stale worktrees')
  })

  it('renders per-section item counts in section headers', () => {
    const draft1 = makeItem({ id: 'd1', kind: 'draft-proposal', entityId: 'e-d1', errorKind: 'draft-proposal', actions: [] })
    const draft2 = makeItem({ id: 'd2', kind: 'draft-proposal', entityId: 'e-d2', errorKind: 'draft-proposal', actions: [] })
    const failed = makeItem({ id: 'f1', kind: 'failed-task', actions: [] })
    const html = renderPage([draft1, draft2, failed])
    // Section header text is "Drafts 2" and "Failed tasks 1"
    expect(html).toContain('Drafts 2')
    expect(html).toContain('Failed tasks 1')
    // Stale worktrees bucket is empty — header must not appear
    expect(html).not.toContain('Stale worktrees')
  })

  it('omits a section header when that kind has no items after filtering', () => {
    const failed = makeItem({ id: 'f1', kind: 'failed-task', actions: [] })
    const html = renderPage([failed])
    expect(html).toContain('Failed tasks')
    expect(html).not.toContain('Drafts')
    expect(html).not.toContain('Stale worktrees')
  })

  it('places draft rows inside the Drafts section and failed rows inside Failed tasks', () => {
    const draft = makeItem({
      id: 'd1',
      kind: 'draft-proposal',
      errorKind: 'draft-proposal',
      title: 'my draft proposal',
      actions: [],
    })
    const failed = makeItem({ id: 'f1', kind: 'failed-task', title: 'my failed task', actions: [] })
    const html = renderPage([draft, failed])
    // Drafts header appears before draft title, which appears before Failed tasks header
    const draftsHeaderPos = html.indexOf('Drafts')
    const draftTitlePos = html.indexOf('my draft proposal')
    const failedHeaderPos = html.indexOf('Failed tasks')
    const failedTitlePos = html.indexOf('my failed task')
    expect(draftsHeaderPos).toBeLessThan(draftTitlePos)
    expect(draftTitlePos).toBeLessThan(failedHeaderPos)
    expect(failedHeaderPos).toBeLessThan(failedTitlePos)
  })

  it('all sections are expanded by default (aria-expanded="true" on each section button)', () => {
    const draft = makeItem({ id: 'd1', kind: 'draft-proposal', errorKind: 'draft-proposal', actions: [] })
    const failed = makeItem({ id: 'f1', kind: 'failed-task', actions: [] })
    const html = renderPage([draft, failed])
    // Both sections carry aria-expanded="true" by default
    const matches = html.match(/aria-expanded="true"/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(2)
  })

  it('row titles are present in the HTML when their section is expanded (default state)', () => {
    const failed = makeItem({ id: 'f1', kind: 'failed-task', title: 'visible task title', actions: [] })
    const html = renderPage([failed])
    // Expanding a section is the default; row content must be in the output
    expect(html).toContain('visible task title')
  })

  it('section body id matches the button aria-controls, linking header to its rows', () => {
    const failed = makeItem({ id: 'f1', kind: 'failed-task', title: 'task x', actions: [] })
    const html = renderPage([failed])
    // aria-controls="section-body-failed-task" and id="section-body-failed-task" must both appear
    expect(html).toContain('aria-controls="section-body-failed-task"')
    expect(html).toContain('id="section-body-failed-task"')
  })
})
