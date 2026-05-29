/**
 * Tests for the inbox detail-panel render — the slice-H rewire.
 *
 * Uses a pre-populated QueryClient so the catalog / events / origins
 * useQuery calls resolve synchronously inside renderToStaticMarkup. Pure
 * render-snapshot assertions; the action-button click handlers are not
 * exercised here (they rely on real React event dispatch).
 */
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ActionQueuePage as _Page, ActionQueueRow } from './TodoPage'
import type {
  ActionQueueItem,
  EventsResponse,
  FailureReasonCatalogEntry,
  OriginsResponse,
} from '@/shared/schemas'

// Silence the unused-variable lint warning. ActionQueuePage is exported to
// confirm the public surface here even though the tests target the
// sub-components via the panel render.
void _Page

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG: FailureReasonCatalogEntry[] = [
  {
    code: 'unknown',
    userMessage: 'Inspect the transcript to triage.',
    recipe: null,
    availableActions: [
      { id: 'investigate', label: 'Investigate', cliHint: null },
      { id: 'restart', label: 'Restart', cliHint: 'mars restart <id>' },
    ],
  },
  {
    code: 'verify:typecheck',
    userMessage: 'TypeScript typecheck failed in the verify step.',
    recipe: null,
    availableActions: [
      { id: 'restart', label: 'Restart', cliHint: 'mars restart <id>' },
      { id: 'purge', label: 'Purge', cliHint: 'mars purge <id>' },
    ],
  },
]

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
  dismissed: false,
  ackState: null,
  errorKind: 'failed-task',
  actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
  staleWorktreeDetail: null,
  diagnosis: null,
  failureReasonCode: 'verify:typecheck',
}

const makeItem = (overrides: Partial<ActionQueueItem>): ActionQueueItem => ({
  ...BASE_ITEM,
  ...overrides,
})

// ---------------------------------------------------------------------------
// React Query cache helpers
// ---------------------------------------------------------------------------

/**
 * Build a QueryClient with the catalog, events, and origins responses
 * preloaded so the detail-panel useQuery calls resolve synchronously in
 * renderToStaticMarkup.
 */
const makeClient = (opts: {
  catalog?: FailureReasonCatalogEntry[]
  events?: EventsResponse
  origins?: OriginsResponse
  taskId: string
}): QueryClient => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  qc.setQueryData(['failure-reasons'], opts.catalog ?? CATALOG)
  qc.setQueryData(['events', opts.taskId], opts.events ?? EMPTY_EVENTS)
  qc.setQueryData(
    ['origins', opts.taskId],
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
  qc.setQueryData(['action-queue'], [item])
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
// AC1: A failed-task row with a known code renders the catalog's userMessage.
// ---------------------------------------------------------------------------

describe('inbox detail – Reason section', () => {
  it('renders the catalog userMessage for a known code', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(BASE_ITEM, qc)
    expect(html).toContain('TypeScript typecheck failed in the verify step.')
    expect(html).toContain('>Reason<')
  })

  it('falls back to the unknown entry for an unrecognised code', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(
      makeItem({ failureReasonCode: 'verify:something-new' }),
      qc,
    )
    expect(html).toContain('Inspect the transcript to triage.')
  })

  it('does NOT render the Reason section for a stale-worktree row', () => {
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
    expect(html).not.toContain('>Reason<')
  })
})

// ---------------------------------------------------------------------------
// AC2: Available actions render as buttons from the catalog.
// ---------------------------------------------------------------------------

describe('inbox detail – Available actions', () => {
  it('renders a Restart action button for a verify:typecheck row', () => {
    const qc = makeClient({ taskId: 't-1' })
    const html = renderDetail(BASE_ITEM, qc)
    expect(html).toContain('Available actions')
    // Catalog action labels: Restart and Purge for verify:typecheck.
    expect(html).toContain('>Restart<')
    expect(html).toContain('>Purge<')
  })
})

// ---------------------------------------------------------------------------
// AC3: Traces section.
// ---------------------------------------------------------------------------

describe('inbox detail – Traces section', () => {
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
    expect(html).toContain('No trace events recorded for this task.')
  })
})

// ---------------------------------------------------------------------------
// AC4: Origins section.
// ---------------------------------------------------------------------------

describe('inbox detail – Origins section', () => {
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
