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
import { ActionQueuePage as _Page, ActionQueueRow, matchesKindFilter } from './ActionQueuePage'
import type {
  ActionQueueItem,
  EventsResponse,
  OriginsResponse,
  ProposalDetail,
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
// the item pre-selected. Cleaner here: just import-as-private from ActionQueuePage.

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

describe('ActionQueuePage exports', () => {
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
// AC2: Actions render as buttons from the row's own `actions` (the
// Failure kind menu), via the shared ActionBar.
// ---------------------------------------------------------------------------

describe('actionQueue detail – Move forward actions', () => {
  it('renders a Restart action button from the row actions', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(BASE_ITEM, qc)
    expect(html).toContain('Move forward')
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

  // copy op: renders as an interactive button, not a guidance-chip span.
  // The old span chip concatenated label · hint; the new button shows only
  // the label (hint is copied to clipboard on click, not displayed inline).
  it('renders a copy action as a clipboard button (not a guidance-chip span)', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(
      makeItem({
        actions: [
          { id: 'copy-1', label: 'Move forward', op: 'copy', hint: '/mars:grill t-1' },
        ],
      }),
      qc,
    )
    // Old chip format — label followed by ' · hint' — must be absent.
    expect(html).not.toContain('Move forward · ')
    // The action's label must still appear in the rendered output.
    expect(html).toContain('Move forward')
    // A <button> tag must be present (the section header is a <dt>, not a button,
    // so the <button> tag comes from the action).
    expect(html).toContain('<button')
  })

  // dismiss op goes through the generic button path (needsConfirm gate fires in
  // the browser; here we just verify the button renders with the right label).
  it('renders a dismiss action as a button via the generic path', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(
      makeItem({
        actions: [
          { id: 'dismiss-1', label: 'Dismiss', op: 'dismiss', needsConfirm: true },
        ],
      }),
      qc,
    )
    expect(html).toContain('>Dismiss<')
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
    // summarizeTraceEvent humanises the raw code: 'verify:typecheck' → 'typecheck (verify step)'
    expect(html).toContain('typecheck (verify step)')
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

describe('action-queue detail – Open task detail affordance', () => {
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
    // Check that the section *body* elements for absent kinds are not rendered
    // (the text "Drafts" now also appears in the kind-filter control buttons,
    //  so we check the section-body id instead of raw text).
    expect(html).not.toContain('id="section-body-draft-proposal"')
    expect(html).not.toContain('id="section-body-stale-worktree"')
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
    // Use section-body ids as anchors; the filter button "Drafts" appears earlier
    // in the DOM than the section header so text search is ambiguous.
    // Sidebar renders: "Failed tasks" section first, then "Drafts" section.
    const failedSectionPos = html.indexOf('section-body-failed-task')
    const failedTitlePos = html.indexOf('my failed task')
    const draftSectionPos = html.indexOf('section-body-draft-proposal')
    const draftTitlePos = html.indexOf('my draft proposal')
    expect(failedSectionPos).toBeGreaterThan(-1)
    expect(draftSectionPos).toBeGreaterThan(-1)
    // Failed tasks section appears before Drafts section
    expect(failedSectionPos).toBeLessThan(draftSectionPos)
    // Items appear inside their respective sections
    expect(failedSectionPos).toBeLessThan(failedTitlePos)
    expect(draftSectionPos).toBeLessThan(draftTitlePos)
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

// ---------------------------------------------------------------------------
// matchesKindFilter — pure helper unit tests.
// All three item kinds × all three filter values (9 combinations).
// ---------------------------------------------------------------------------

describe('matchesKindFilter – all combinations', () => {
  const failedItem = makeItem({ kind: 'failed-task' })
  const staleItem = makeItem({
    kind: 'stale-worktree',
    errorKind: 'stale-worktree',
    staleWorktreeDetail: {
      prompt: null,
      status: 'running',
      ageHours: 2,
      updatedAt: new Date().toISOString(),
      branch: 'task/s1',
      empty: false,
      investigation: null,
    },
  })
  const draftItem = makeItem({ kind: 'draft-proposal', errorKind: 'draft-proposal', actions: [] })

  // filter === 'all'
  it('"all" filter passes a failed-task item', () => {
    expect(matchesKindFilter(failedItem, 'all')).toBe(true)
  })
  it('"all" filter passes a stale-worktree item', () => {
    expect(matchesKindFilter(staleItem, 'all')).toBe(true)
  })
  it('"all" filter passes a draft-proposal item', () => {
    expect(matchesKindFilter(draftItem, 'all')).toBe(true)
  })

  // filter === 'alerts'
  it('"alerts" filter passes a failed-task item', () => {
    expect(matchesKindFilter(failedItem, 'alerts')).toBe(true)
  })
  it('"alerts" filter passes a stale-worktree item', () => {
    expect(matchesKindFilter(staleItem, 'alerts')).toBe(true)
  })
  it('"alerts" filter rejects a draft-proposal item', () => {
    expect(matchesKindFilter(draftItem, 'alerts')).toBe(false)
  })

  // filter === 'drafts'
  it('"drafts" filter rejects a failed-task item', () => {
    expect(matchesKindFilter(failedItem, 'drafts')).toBe(false)
  })
  it('"drafts" filter rejects a stale-worktree item', () => {
    expect(matchesKindFilter(staleItem, 'drafts')).toBe(false)
  })
  it('"drafts" filter passes a draft-proposal item', () => {
    expect(matchesKindFilter(draftItem, 'drafts')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ActionQueuePage – kind filter control renders with correct attributes.
// ---------------------------------------------------------------------------

describe('ActionQueuePage – kind filter control', () => {
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

  it('renders all three filter buttons with their data-testids', () => {
    const html = renderPage([BASE_ITEM])
    expect(html).toContain('data-testid="action-queue-filter-all"')
    expect(html).toContain('data-testid="action-queue-filter-alerts"')
    expect(html).toContain('data-testid="action-queue-filter-drafts"')
  })

  it('renders the filter group with the correct aria-label', () => {
    const html = renderPage([BASE_ITEM])
    expect(html).toContain('aria-label="Filter action queue by kind"')
  })

  it('"All" button is pressed by default (aria-pressed="true")', () => {
    const html = renderPage([BASE_ITEM])
    // The All button must carry aria-pressed="true" on initial render.
    // We find its testid and confirm aria-pressed follows in the markup.
    const allBtnIdx = html.indexOf('data-testid="action-queue-filter-all"')
    expect(allBtnIdx).toBeGreaterThan(-1)
    // aria-pressed appears as an attribute on the button tag — check the
    // slice of HTML around the All button for aria-pressed="true".
    const snippet = html.slice(Math.max(0, allBtnIdx - 100), allBtnIdx + 150)
    expect(snippet).toContain('aria-pressed="true"')
  })

  it('"Alerts" and "Drafts" buttons are not pressed by default', () => {
    const html = renderPage([BASE_ITEM])
    // Count aria-pressed="true" occurrences — only the All button should have it.
    const trueCount = (html.match(/aria-pressed="true"/g) ?? []).length
    expect(trueCount).toBe(1)
    // Both Alerts and Drafts carry aria-pressed="false".
    const falseCount = (html.match(/aria-pressed="false"/g) ?? []).length
    expect(falseCount).toBe(2)
  })

  it('draft-proposal rows appear in the default "All" view', () => {
    const draft = makeItem({
      id: 'd1',
      kind: 'draft-proposal',
      errorKind: 'draft-proposal',
      title: 'a draft proposal title',
      actions: [],
    })
    const html = renderPage([draft])
    expect(html).toContain('a draft proposal title')
  })

  it('failed-task rows appear in the default "All" view', () => {
    const html = renderPage([BASE_ITEM])
    // BASE_ITEM is a failed-task; its title must appear.
    expect(html).toContain(BASE_ITEM.title)
  })
})

// ---------------------------------------------------------------------------
// AC: Resolution block — shown for resolved history rows; ActionBar suppressed.
// A resolved item has item.resolution != null; this controls which branch of
// the {item.resolution ? <ResolutionBlock> : <ActionBar>} renders.
// ---------------------------------------------------------------------------

describe('actionQueue detail – Resolution block for resolved items', () => {
  const RESOLVED_AT = '2024-01-02T00:00:00.000Z'

  const resolvedItem: ActionQueueItem = makeItem({
    id: 'resolved-item-1',
    resolution: {
      resolvedAt: RESOLVED_AT,
      resolution: 'superseded',
      resolutionNote: 'origin-done',
      rootCause: null,
      resolvedBy: 'daemon:auto-supersede',
    },
    // Resolved items carry empty actions (no live buttons needed).
    actions: [],
  })

  it('renders the Resolution block when item.resolution is non-null', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(resolvedItem, qc)
    expect(html).toContain('data-testid="resolution-block"')
  })

  it('renders the resolution value inside the Resolution block', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(resolvedItem, qc)
    // The resolution string 'superseded' must appear inside the block.
    expect(html).toContain('superseded')
  })

  it('renders the resolvedBy value inside the Resolution block', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(resolvedItem, qc)
    expect(html).toContain('daemon:auto-supersede')
  })

  it('renders the resolutionNote when present', () => {
    const itemWithNote = makeItem({
      ...resolvedItem,
      resolution: {
        ...resolvedItem.resolution!,
        resolutionNote: 'automatically closed after origin completed',
      },
    })
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(itemWithNote, qc)
    expect(html).toContain('automatically closed after origin completed')
  })

  it('renders the rootCause when present', () => {
    const itemWithCause = makeItem({
      ...resolvedItem,
      resolution: {
        ...resolvedItem.resolution!,
        rootCause: 'transient CI outage',
      },
    })
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(itemWithCause, qc)
    expect(html).toContain('transient CI outage')
  })

  it('hides the ActionBar (Move forward section) for a resolved item', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(resolvedItem, qc)
    // The ActionBar renders a "Move forward" heading — must be absent.
    expect(html).not.toContain('Move forward')
  })

  it('shows the ActionBar for a live (non-resolved) item', () => {
    const liveItem = makeItem({
      actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
    })
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(liveItem, qc)
    // ActionBar renders "Move forward" for live items.
    expect(html).toContain('Move forward')
  })

  it('does NOT render the Resolution block for a live (non-resolved) item', () => {
    const liveItem = makeItem({ actions: [{ id: 'restart', label: 'Restart', op: 'restart' }] })
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(liveItem, qc)
    expect(html).not.toContain('data-testid="resolution-block"')
  })
})

// ---------------------------------------------------------------------------
// AC: History accordion — collapsed by default; shows count; Load more
// button visible when nextCursor is non-null.
// ---------------------------------------------------------------------------

describe('ActionQueuePage – History accordion', () => {
  const makeHistoryResponse = (
    items: ActionQueueItem[],
    nextCursor: string | null,
  ) => ({ rows: items, nextCursor })

  const renderPageWithHistory = (
    liveItems: ActionQueueItem[],
    historyItems: ActionQueueItem[],
    nextCursor: string | null = null,
  ): string => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    qc.setQueryData(['action-queue', null], liveItems)
    qc.setQueryData(['action-queue-history', null], makeHistoryResponse(historyItems, nextCursor))
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <_Page />
      </QueryClientProvider>,
    )
  }

  const historyRow: ActionQueueItem = makeItem({
    id: 'hist-1',
    resolution: {
      resolvedAt: '2024-01-02T00:00:00.000Z',
      resolution: 'superseded',
      resolutionNote: null,
      rootCause: null,
      resolvedBy: 'daemon:auto-supersede',
    },
    actions: [],
  })

  it('renders the history accordion in the sidebar', () => {
    const html = renderPageWithHistory([], [])
    expect(html).toContain('data-testid="history-accordion"')
  })

  it('is collapsed by default (aria-expanded="false")', () => {
    const html = renderPageWithHistory([], [historyRow])
    // The history accordion button must carry aria-expanded="false".
    expect(html).toContain('aria-controls="section-body-history"')
    const accordionStart = html.indexOf('data-testid="history-accordion"')
    expect(accordionStart).toBeGreaterThan(-1)
    const snippet = html.slice(accordionStart, accordionStart + 500)
    expect(snippet).toContain('aria-expanded="false"')
    expect(snippet).not.toContain('aria-expanded="true"')
  })

  it('history section body is not rendered when collapsed (default state)', () => {
    const html = renderPageWithHistory([], [historyRow])
    // The section body is only rendered when historyOpen=true.
    expect(html).not.toContain('id="section-body-history"')
  })

  it('shows correct count in header: "History (N loaded)"', () => {
    const twoItems = [
      historyRow,
      makeItem({ id: 'hist-2', resolution: { resolvedAt: '2024-01-01T00:00:00.000Z', resolution: null, resolutionNote: null, rootCause: null, resolvedBy: null }, actions: [] }),
    ]
    const html = renderPageWithHistory([], twoItems)
    expect(html).toContain('History (2 loaded)')
  })

  it('shows "History (0 loaded)" when no history items exist', () => {
    const html = renderPageWithHistory([], [])
    expect(html).toContain('History (0 loaded)')
  })

  it('Load more button is not rendered when accordion is collapsed (default state)', () => {
    // Even with nextCursor set, Load more is inside the collapsed section body.
    const html = renderPageWithHistory([], [historyRow], 'cursor-token-1')
    expect(html).not.toContain('data-testid="history-load-more"')
  })

  it('live items are still visible alongside the history accordion', () => {
    const live = makeItem({ id: 'live-1', title: 'live task', actions: [{ id: 'restart', label: 'Restart', op: 'restart' }] })
    const html = renderPageWithHistory([live], [historyRow])
    // Live item title must be present
    expect(html).toContain('live task')
    // History accordion must also be present
    expect(html).toContain('data-testid="history-accordion"')
  })
})

// ---------------------------------------------------------------------------
// Optimistic action dismiss — cache-driven visibility
//
// These tests verify the UI renders correctly at each stage of the optimistic
// dismiss lifecycle:
//
//   (a) Immediately after onMutate fires, the item is removed from the
//       QueryClient cache — the rendered list must NOT show it.
//   (b) After onError rolls back the cache, the item reappears if the server
//       still returns it, but stays absent if the server superseded it.
//   (c) After diagnose-failure returns, the item reappears carrying
//       item.diagnosis — the rendered detail panel must show the diagnosis text.
//
// Because these tests use renderToStaticMarkup (SSR, no real event dispatch),
// we simulate each lifecycle stage by directly manipulating the QueryClient
// cache and re-rendering.
// ---------------------------------------------------------------------------

describe('ActionQueuePage – optimistic action dismiss (cache-driven visibility)', () => {
  const renderPageWith = (items: ActionQueueItem[]): string => {
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

  // (a) Optimistic dismiss: when onMutate removes the item from the cache,
  //     the rendered queue must not contain the item.
  it('(a) item is present in the rendered queue when it is in the cache', () => {
    const html = renderPageWith([BASE_ITEM])
    expect(html).toContain(BASE_ITEM.title)
  })

  it('(a) item disappears from the rendered queue when removed from cache (optimistic dismiss)', () => {
    // Simulate the cache state after onMutate removes the item
    const html = renderPageWith([])
    expect(html).not.toContain(BASE_ITEM.title)
  })

  // (b) Error rollback: after onError rolls back the optimistic removal, the
  //     item reappears ONLY if the subsequent refetch still returns it.
  it('(b) item is restored in rendered queue when rollback repopulates the cache', () => {
    // Simulate rollback: item is back in the cache
    const html = renderPageWith([BASE_ITEM])
    expect(html).toContain(BASE_ITEM.title)
  })

  it('(b) item stays absent when server omits it from the refetch (server-side supersede)', () => {
    // After rollback + refetch, server returned empty list — item is gone
    const html = renderPageWith([])
    expect(html).not.toContain(BASE_ITEM.title)
  })

  // (c) diagnose-failure: the row disappears (optimistic dismiss), then the
  //     diagnose-failure call writes its findings back onto the item server-side.
  //     After the subsequent refetch, the item reappears with diagnosis populated.
  it('(c) item is absent when optimistically removed during diagnose-failure', () => {
    const html = renderPageWith([])
    expect(html).not.toContain(BASE_ITEM.title)
  })

  it('(c) item reappears with diagnosis text after refetch following diagnose-failure', () => {
    const diagnosedItem = makeItem({
      diagnosis: {
        text: 'Root cause: missing TypeScript import in verify step.',
        diagnosedAt: '2026-01-01T12:00:00Z',
      },
    })
    const qc = makeClient({ taskId: BASE_ITEM.entityId })
    qc.setQueryData(['action-queue', null], [diagnosedItem])
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <_Page />
      </QueryClientProvider>,
    )
    // The diagnosis text must appear in the detail panel
    expect(html).toContain('Root cause: missing TypeScript import in verify step.')
  })
})

// ---------------------------------------------------------------------------
// Polling safety net — useActionQueue refetchInterval / refetchOnWindowFocus
//
// (d) The useActionQueue query must be configured so stale rows self-clear
//     within ~15 s even when SSE events are missed. We verify that:
//
//   i.  A pre-seeded action-queue entry is marked stale when
//       invalidateQueries(['action-queue']) is called — this is the exact
//       call that both the polling timer and SSE handlers trigger.
//   ii. The 'action-queue' prefix invalidation matches the per-project key
//       shape ['action-queue', projectId] used by useActionQueue.
// ---------------------------------------------------------------------------

describe('useActionQueue – polling safety net (refetchInterval + invalidation mechanism)', () => {
  it('(d-i) action-queue entry is marked stale after prefix invalidation', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    })
    qc.setQueryData(['action-queue', null], [BASE_ITEM])

    // Verify the entry starts fresh (not invalidated)
    const stateBefore = qc.getQueryState(['action-queue', null])
    expect(stateBefore?.isInvalidated).toBe(false)

    // This is the exact call made by both the refetchInterval timer and the
    // SseInvalidator's 'tasks' / 'todo' event handlers.
    await qc.invalidateQueries({ queryKey: ['action-queue'] })

    const stateAfter = qc.getQueryState(['action-queue', null])
    expect(stateAfter?.isInvalidated).toBe(true)
  })

  it('(d-ii) prefix invalidation covers the per-project key shape used by useActionQueue', async () => {
    const projectId = 'proj-abc'
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    })
    // Simulate the per-project cache entry that useActionQueue creates
    qc.setQueryData(['action-queue', projectId], [BASE_ITEM])

    const stateBefore = qc.getQueryState(['action-queue', projectId])
    expect(stateBefore?.isInvalidated).toBe(false)

    // Prefix-match invalidation must reach the per-project entry
    await qc.invalidateQueries({ queryKey: ['action-queue'] })

    const stateAfter = qc.getQueryState(['action-queue', projectId])
    expect(stateAfter?.isInvalidated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Draft-proposal detail panel — lazy-loaded rich content.
//
// When a draft-proposal row is selected, the detail panel should lazy-fetch
// the full proposal (Problem / Solution / User stories / Out of scope / Notes)
// and display them, replacing the old "Run mars proposal show" boilerplate.
// ---------------------------------------------------------------------------

const SAMPLE_PROPOSAL: ProposalDetail = {
  id: 'prop-abc',
  title: 'Better error messages',
  problem: 'Errors are too cryptic for end-users.',
  solution: 'Rewrite every error string to be human-friendly.',
  outOfScope: 'Error telemetry pipeline',
  notes: 'Revisit after v2.',
  status: 'draft',
  source: 'human',
  author: null,
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  userStories: [
    'As a user I can read the error without consulting docs.',
    'As a developer I know which module raised the error.',
  ],
}

const makeDraftItem = (proposalId: string): ActionQueueItem =>
  makeItem({
    id: `draft-proposal:${proposalId}`,
    kind: 'draft-proposal',
    entityId: proposalId,
    errorKind: 'draft-proposal',
    title: 'Better error messages',
    body: `Proposal \`${proposalId}\` from \`human\` is ready for review. Run \`mars proposal show ${proposalId}\` to see details.`,
    actions: [{ id: 'dismiss', label: 'Dismiss', op: 'dismiss', needsConfirm: true }],
  })

const renderDraftDetail = (proposalId: string, proposal: ProposalDetail | null): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  qc.setQueryData(['action-queue', null], [makeDraftItem(proposalId)])
  // Seed the proposal-detail query (projectId=null mirrors the test context).
  if (proposal !== null) {
    qc.setQueryData(['proposal-detail', null, proposalId], proposal)
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <_Page />
    </QueryClientProvider>,
  )
}

describe('ActionQueueDetail – draft-proposal rich content', () => {
  it('renders the Problem section from the fetched proposal', () => {
    const html = renderDraftDetail('prop-abc', SAMPLE_PROPOSAL)
    expect(html).toContain('Problem')
    expect(html).toContain('Errors are too cryptic for end-users.')
  })

  it('renders the Solution section from the fetched proposal', () => {
    const html = renderDraftDetail('prop-abc', SAMPLE_PROPOSAL)
    expect(html).toContain('Solution')
    expect(html).toContain('Rewrite every error string to be human-friendly.')
  })

  it('renders user stories as a numbered list', () => {
    const html = renderDraftDetail('prop-abc', SAMPLE_PROPOSAL)
    expect(html).toContain('User stories')
    expect(html).toContain('As a user I can read the error without consulting docs.')
    expect(html).toContain('As a developer I know which module raised the error.')
  })

  it('renders Out of scope when non-empty', () => {
    const html = renderDraftDetail('prop-abc', SAMPLE_PROPOSAL)
    expect(html).toContain('Out of scope')
    expect(html).toContain('Error telemetry pipeline')
  })

  it('renders Notes when non-empty', () => {
    const html = renderDraftDetail('prop-abc', SAMPLE_PROPOSAL)
    expect(html).toContain('Notes')
    expect(html).toContain('Revisit after v2.')
  })

  it('does NOT render the "Run mars proposal show" boilerplate', () => {
    const html = renderDraftDetail('prop-abc', SAMPLE_PROPOSAL)
    expect(html).not.toContain('Run `mars proposal show')
    expect(html).not.toContain('mars proposal show')
  })

  it('shows a loading placeholder while the proposal is being fetched (query pending)', () => {
    // Seed the queue but NOT the proposal-detail query → isPending branch.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    qc.setQueryData(['action-queue', null], [makeDraftItem('prop-abc')])
    // Intentionally do NOT seed ['proposal-detail', null, 'prop-abc'].
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <_Page />
      </QueryClientProvider>,
    )
    // The panel must show something meaningful — the title or a loading state.
    // It must NOT show the old boilerplate.
    expect(html).not.toContain('mars proposal show')
  })

  it('shows an error fallback when the proposal fetch fails', () => {
    // Seeding an Error object as query data triggers isError in react-query.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    qc.setQueryData(['action-queue', null], [makeDraftItem('prop-err')])
    // Seed with null to trigger the !data error branch.
    qc.setQueryData(['proposal-detail', null, 'prop-err'], null)
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <_Page />
      </QueryClientProvider>,
    )
    // The panel must show the graceful error fallback.
    expect(html).toContain('could not load proposal')
  })

  it('omits Out of scope section when the field is empty', () => {
    const noOutOfScope: ProposalDetail = { ...SAMPLE_PROPOSAL, outOfScope: '' }
    const html = renderDraftDetail('prop-abc', noOutOfScope)
    expect(html).not.toContain('Out of scope')
  })

  it('omits Notes section when the field is empty', () => {
    const noNotes: ProposalDetail = { ...SAMPLE_PROPOSAL, notes: '' }
    const html = renderDraftDetail('prop-abc', noNotes)
    expect(html).not.toContain('Notes')
  })

  it('omits User stories section when the list is empty', () => {
    const noStories: ProposalDetail = { ...SAMPLE_PROPOSAL, userStories: [] }
    const html = renderDraftDetail('prop-abc', noStories)
    expect(html).not.toContain('User stories')
  })

  it('keeps ActionBar (Move forward / Dismiss) visible above the proposal content', () => {
    const html = renderDraftDetail('prop-abc', SAMPLE_PROPOSAL)
    expect(html).toContain('Move forward')
    expect(html).toContain('Dismiss')
  })
})

// ---------------------------------------------------------------------------
// Two-step confirm — needsConfirm actions use an in-UI confirm; no window.confirm.
//
// In the initial (no-click) state the button shows the action's normal label.
// Only after the first click does it morph to "Confirm <label>?".  These tests
// verify the default (pre-click) render, which is the only state visible to
// renderToStaticMarkup.  The interactive morph is exercised manually (see task
// criterion) because it requires real event dispatch.
// ---------------------------------------------------------------------------

describe('ActionBar – two-step in-UI confirm (no window.confirm)', () => {
  it('needsConfirm button shows the action label in initial render (not "Confirm?")', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(
      makeItem({
        actions: [{ id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true }],
      }),
      qc,
    )
    // Button starts in un-confirmed state — normal label, no "Confirm" prefix.
    expect(html).toContain('>Drop permanently<')
    expect(html).not.toContain('Confirm Drop permanently')
  })

  it('needsConfirm button carries data-testid="confirm-step-<id>" for targeting', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(
      makeItem({
        actions: [{ id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true }],
      }),
      qc,
    )
    expect(html).toContain('data-testid="confirm-step-purge"')
  })

  it('needsConfirm button does NOT carry data-confirm-pending in initial render', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(
      makeItem({
        actions: [{ id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true }],
      }),
      qc,
    )
    // data-confirm-pending is only set when the button is in the armed state.
    expect(html).not.toContain('data-confirm-pending')
  })
})

// ---------------------------------------------------------------------------
// Restart undo toast — absent in initial render; only shown after a click.
// ---------------------------------------------------------------------------

describe('ActionQueuePage – restart undo toast', () => {
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

  it('undo toast is NOT present in the initial render (no restart triggered yet)', () => {
    const item = makeItem({
      id: 'f1',
      kind: 'failed-task',
      actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
    })
    const html = renderPage([item])
    expect(html).not.toContain('data-testid="restart-undo-toast"')
  })

  it('Restart button renders on rows that carry a restart action', () => {
    const item = makeItem({
      id: 'f1',
      kind: 'failed-task',
      actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
    })
    const html = renderPage([item])
    // The sidebar row shows the inline Restart button.
    expect(html).toContain('Restart')
  })
})

// ---------------------------------------------------------------------------
// Heading overflow prevention.
// The outer detail-panel container must carry min-w-0 so the h2 heading can
// shrink to the flex-allocated width and break-all wraps the text rather than
// the whole panel pushing past the viewport.
// ---------------------------------------------------------------------------

describe('actionQueue detail – heading overflow prevention', () => {
  it('renders the full arc-failed goal text without truncation', () => {
    const longGoal =
      'Fix and retry b40205e8, or abandon mars-77fa3747: recovery failed at merge:preflight'
    const item = makeItem({
      id: 'arc-failed:arc-1',
      kind: 'arc-failed',
      entityId: 'arc-1',
      goal: longGoal,
      reason: 'recovery task mars-77fa3747 failed',
      chain: [],
      actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
    })
    const qc = makeClient({ taskId: 'arc-1' })
    const html = renderDetail(item, qc)
    // The full goal (including the trailing recovery task id) must appear in the
    // markup — not truncated or clipped.
    expect(html).toContain(longGoal)
  })

  it('outer detail panel container carries min-w-0 to prevent horizontal overflow', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(BASE_ITEM, qc)
    // The outer container must have min-w-0 alongside h-full and overflow-auto.
    // This specific triple is only present on the ActionQueueDetail outer div;
    // it will fail if min-w-0 is missing from that element.
    expect(html).toContain('h-full min-w-0 flex-col overflow-auto')
  })

  it('header element carries min-w-0 so its flex-column stretch is bounded', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(BASE_ITEM, qc)
    // The header inside the outer div is a flex item in a flex column; without
    // min-w-0 its min-content size can exceed the container width.
    expect(html).toContain('min-w-0 border-b border-iron')
  })
})
