import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DraftFeature, ProgressTask } from '@/shared/schemas'
import { BoardView } from './BoardView'

const task = (
  overrides: Partial<ProgressTask> & { id: string; cluster: ProgressTask['cluster'] },
): ProgressTask => ({
  id: overrides.id,
  prompt: overrides.prompt ?? `Task ${overrides.id}`,
  status: overrides.status ?? 'queued',
  plan: null,
  branch: null,
  worktreePath: null,
  error: null,
  dropReason: null,
  retryCount: 0,
  blockerTaskId: null,
  blockedBy: [],
  spec: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  cluster: overrides.cluster,
  parentProposalId: overrides.parentProposalId ?? null,
  ...overrides,
})

const draft = (id: string, title = `Draft ${id}`): DraftFeature => ({
  id,
  title,
  problem: 'problem',
  solution: 'solution',
  status: 'draft',
  source: 'human',
  createdAt: 0,
  updatedAt: 0,
  acceptanceCount: 0,
  userStories: [],
})

const emptyByCluster = () => ({
  Queued: [] as ProgressTask[],
  'In progress': [] as ProgressTask[],
  Blocked: [] as ProgressTask[],
  Failed: [] as ProgressTask[],
})

describe('BoardView – proposal filter on cluster columns', () => {
  it('shows only tasks from the selected proposal when a filter is active', () => {
    const t1 = task({ id: 'task-from-p1', cluster: 'Queued', parentProposalId: 'p1' })
    const t2 = task({ id: 'task-from-p2', cluster: 'Queued', parentProposalId: 'p2' })
    const byCluster = { ...emptyByCluster(), Queued: [t1, t2] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} drafts={[]} error={null} selectedProposalId="p1" />,
    )

    expect(html).toContain('task-from-p1')
    expect(html).not.toContain('task-from-p2')
  })

  it('shows all tasks when no proposal filter is active', () => {
    const t1 = task({ id: 'task-from-p1', cluster: 'Queued', parentProposalId: 'p1' })
    const t2 = task({ id: 'task-from-p2', cluster: 'Queued', parentProposalId: 'p2' })
    const byCluster = { ...emptyByCluster(), Queued: [t1, t2] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} drafts={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('task-from-p1')
    expect(html).toContain('task-from-p2')
  })

  it('filters tasks across multiple cluster columns', () => {
    const t1 = task({ id: 'p1-queued', cluster: 'Queued', parentProposalId: 'p1' })
    const t2 = task({ id: 'p2-queued', cluster: 'Queued', parentProposalId: 'p2' })
    const t3 = task({
      id: 'p1-running',
      cluster: 'In progress',
      status: 'running',
      parentProposalId: 'p1',
    })
    const t4 = task({
      id: 'p2-running',
      cluster: 'In progress',
      status: 'running',
      parentProposalId: 'p2',
    })
    const byCluster = {
      ...emptyByCluster(),
      Queued: [t1, t2],
      'In progress': [t3, t4],
    }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} drafts={[]} error={null} selectedProposalId="p1" />,
    )

    expect(html).toContain('p1-queued')
    expect(html).not.toContain('p2-queued')
    expect(html).toContain('p1-running')
    expect(html).not.toContain('p2-running')
  })

  it('removes tasks with no parentProposalId from columns when a filter is active', () => {
    const t1 = task({ id: 'no-parent', cluster: 'Queued', parentProposalId: null })
    const t2 = task({ id: 'p1-task', cluster: 'Queued', parentProposalId: 'p1' })
    const byCluster = { ...emptyByCluster(), Queued: [t1, t2] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} drafts={[]} error={null} selectedProposalId="p1" />,
    )

    expect(html).toContain('p1-task')
    expect(html).not.toContain('no-parent')
  })

  it('restores all tasks when the proposal filter is cleared (null)', () => {
    const t1 = task({ id: 'no-parent', cluster: 'Queued', parentProposalId: null })
    const t2 = task({ id: 'p1-task', cluster: 'Queued', parentProposalId: 'p1' })
    const byCluster = { ...emptyByCluster(), Queued: [t1, t2] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} drafts={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('no-parent')
    expect(html).toContain('p1-task')
  })
})

describe('BoardView – search filter on cluster columns', () => {
  it('shows only cards whose id is in searchMatchIds when filter is active', () => {
    const t1 = task({ id: 'task-a', cluster: 'Queued' })
    const t2 = task({ id: 'task-b', cluster: 'Queued' })
    const byCluster = { ...emptyByCluster(), Queued: [t1, t2] }

    const html = renderToStaticMarkup(
      <BoardView
        byCluster={byCluster}
        drafts={[]}
        error={null}
        selectedProposalId={null}
        searchMatchIds={new Set(['task-a'])}
      />,
    )

    expect(html).toContain('task-a')
    expect(html).not.toContain('task-b')
  })

  it('removes non-matching cards across multiple cluster columns', () => {
    const t1 = task({ id: 'match-q', cluster: 'Queued' })
    const t2 = task({ id: 'no-q', cluster: 'Queued' })
    const t3 = task({ id: 'match-ip', cluster: 'In progress', status: 'running' })
    const t4 = task({ id: 'no-ip', cluster: 'In progress', status: 'running' })
    const byCluster = { ...emptyByCluster(), Queued: [t1, t2], 'In progress': [t3, t4] }

    const html = renderToStaticMarkup(
      <BoardView
        byCluster={byCluster}
        drafts={[]}
        error={null}
        selectedProposalId={null}
        searchMatchIds={new Set(['match-q', 'match-ip'])}
      />,
    )

    expect(html).toContain('match-q')
    expect(html).not.toContain('no-q')
    expect(html).toContain('match-ip')
    expect(html).not.toContain('no-ip')
  })

  it('restores all cards when searchMatchIds is null', () => {
    const t1 = task({ id: 'task-a', cluster: 'Queued' })
    const t2 = task({ id: 'task-b', cluster: 'Queued' })
    const byCluster = { ...emptyByCluster(), Queued: [t1, t2] }

    const html = renderToStaticMarkup(
      <BoardView
        byCluster={byCluster}
        drafts={[]}
        error={null}
        selectedProposalId={null}
        searchMatchIds={null}
      />,
    )

    expect(html).toContain('task-a')
    expect(html).toContain('task-b')
  })
})

describe('BoardView – mobile responsive tab strip (single-column below breakpoint)', () => {
  it('renders a tab strip with a button for each cluster status', () => {
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} drafts={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('data-testid="board-tab-strip"')
    expect(html).toContain('data-tab="Queued"')
    expect(html).toContain('data-tab="In progress"')
    expect(html).toContain('data-tab="Blocked"')
    expect(html).toContain('data-tab="Failed"')
  })

  it('omits the Proposals tab when there are no visible drafts', () => {
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} drafts={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).not.toContain('data-tab="Proposals"')
  })

  it('includes the Proposals tab when drafts are present', () => {
    const d1 = draft('p1', 'Feature Alpha')
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} drafts={[d1]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('data-tab="Proposals"')
  })

  it('defaults the active tab to Failed when failed tasks are present', () => {
    const t = task({ id: 'f1', cluster: 'Failed', status: 'failed' })
    const byCluster = { ...emptyByCluster(), Failed: [t] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} drafts={[]} error={null} selectedProposalId={null} />,
    )

    // The Failed tab button carries aria-selected=true; Queued does not
    expect(html).toMatch(/data-tab="Failed"[^>]*aria-selected="true"/)
    expect(html).toMatch(/data-tab="Queued"[^>]*aria-selected="false"/)
  })

  it('defaults to In progress when no failures but in-progress tasks exist', () => {
    const t = task({ id: 'r1', cluster: 'In progress', status: 'running' })
    const byCluster = { ...emptyByCluster(), 'In progress': [t] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} drafts={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toMatch(/data-tab="In progress"[^>]*aria-selected="true"/)
    expect(html).toMatch(/data-tab="Failed"[^>]*aria-selected="false"/)
  })

  it('defaults to Queued when board is empty (no failed, no in-progress)', () => {
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} drafts={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toMatch(/data-tab="Queued"[^>]*aria-selected="true"/)
  })

  it('marks non-active cluster column wrappers as hidden on mobile (class starts with "hidden")', () => {
    const t = task({ id: 'f1', cluster: 'Failed', status: 'failed' })
    const byCluster = { ...emptyByCluster(), Failed: [t] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} drafts={[]} error={null} selectedProposalId={null} />,
    )

    // Active column wrapper (Failed) should NOT start with hidden
    expect(html).toMatch(/data-cluster="Failed"[^>]*class="flex/)
    // Inactive column wrappers should start with hidden
    expect(html).toMatch(/data-cluster="Queued"[^>]*class="hidden/)
    expect(html).toMatch(/data-cluster="In progress"[^>]*class="hidden/)
    expect(html).toMatch(/data-cluster="Blocked"[^>]*class="hidden/)
  })

  it('shows count badges for tabs with tasks', () => {
    const t = task({ id: 'f1', cluster: 'Failed', status: 'failed' })
    const byCluster = { ...emptyByCluster(), Failed: [t] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} drafts={[]} error={null} selectedProposalId={null} />,
    )

    // Count "1" should appear near the Failed tab
    expect(html).toContain('>1<')
  })
})

describe('BoardView – proposal filter on Proposals column', () => {
  it('shows only the selected proposal draft when a filter is active', () => {
    const d1 = draft('p1', 'Feature Alpha')
    const d2 = draft('p2', 'Feature Beta')

    const html = renderToStaticMarkup(
      <BoardView
        byCluster={emptyByCluster()}
        drafts={[d1, d2]}
        error={null}
        selectedProposalId="p1"
      />,
    )

    expect(html).toContain('Feature Alpha')
    expect(html).not.toContain('Feature Beta')
  })

  it('shows all proposal drafts when no filter is active', () => {
    const d1 = draft('p1', 'Feature Alpha')
    const d2 = draft('p2', 'Feature Beta')

    const html = renderToStaticMarkup(
      <BoardView
        byCluster={emptyByCluster()}
        drafts={[d1, d2]}
        error={null}
        selectedProposalId={null}
      />,
    )

    expect(html).toContain('Feature Alpha')
    expect(html).toContain('Feature Beta')
  })
})

describe('BoardView – column lane styling (no card-in-card nesting)', () => {
  it('board columns are styled as borderless lanes, not bordered cards', () => {
    const t1 = task({ id: 'task-q', cluster: 'Queued' })
    const byCluster = { ...emptyByCluster(), Queued: [t1] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} drafts={[]} error={null} selectedProposalId={null} />,
    )

    // Column lane wrappers must not add a card-level border around already-bordered TaskCards.
    // The combination "border border-border bg-panel" is the column card anti-pattern.
    expect(html).not.toContain('border border-border bg-panel')
  })

  it('Proposals column is also styled as a borderless lane', () => {
    const d1 = draft('p1', 'Feature Alpha')

    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} drafts={[d1]} error={null} selectedProposalId={null} />,
    )

    expect(html).not.toContain('border border-border bg-panel')
  })

  it('column header carries an underline to preserve visual separation without full card chrome', () => {
    const t1 = task({ id: 'task-q', cluster: 'Queued' })
    const byCluster = { ...emptyByCluster(), Queued: [t1] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} drafts={[]} error={null} selectedProposalId={null} />,
    )

    // The column <header> element (not the tab strip) must carry a border-b underline
    // so the lane heading is visually separated from cards without a full card border.
    expect(html).toMatch(/<header[^>]*class="[^"]*\bborder-b\b/)
  })
})
