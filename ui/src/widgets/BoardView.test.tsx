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
