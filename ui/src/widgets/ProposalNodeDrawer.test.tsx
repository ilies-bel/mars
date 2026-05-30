import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import { ProposalNodeDrawer } from './ProposalNodeDrawer'

// ── Test helpers ──────────────────────────────────────────────────────────────

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
  blockedBy: overrides.blockedBy ?? [],
  spec: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  cluster: overrides.cluster,
  parentProposalId: overrides.parentProposalId ?? null,
  ...overrides,
})

const proposal = (id: string, title = `Goal ${id}`): ProgressProposalNode => ({
  id,
  title,
  source: 'human',
  status: 'prd-ready',
})

// ── AC1: Drawer surface (same shell as TaskDetailDrawer) ──────────────────────

describe('ProposalNodeDrawer – surface identity', () => {
  it('renders a dialog element with a consistent testid', () => {
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1', 'My feature')]}
        tasks={[]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-testid="proposal-node-drawer"')
    expect(html).toContain('role="dialog"')
  })

  it('exposes a close control', () => {
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-testid="proposal-node-close"')
  })

  it('renders a scrim overlay element alongside the drawer panel', () => {
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-testid="proposal-node-overlay"')
  })

  it('scrim is aria-hidden so it does not pollute the screen reader tree', () => {
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('aria-hidden="true"')
  })

  it('displays the proposal id in the drawer heading', () => {
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p-xyz"
        proposals={[proposal('p-xyz', 'My proposal')]}
        tasks={[]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('p-xyz')
  })
})

// ── AC2: Placeholder for Proposal detail ──────────────────────────────────────

describe('ProposalNodeDrawer – placeholder', () => {
  it('shows a clearly-labeled placeholder section for Proposal detail', () => {
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-testid="proposal-node-placeholder"')
  })

  it('placeholder text references proposal detail (not task detail)', () => {
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[]}
        onClose={() => {}}
      />,
    )
    // The placeholder should make it clear it's for proposals, not tasks
    expect(html.toLowerCase()).toMatch(/proposal/i)
    expect(html).toContain('data-testid="proposal-node-placeholder"')
  })
})

// ── AC3: Local subgraph ───────────────────────────────────────────────────────

describe('ProposalNodeDrawer – local subgraph', () => {
  it('renders a subgraph section when tasks prop is provided', () => {
    const t1 = task({ id: 't1', cluster: 'In progress', parentProposalId: 'p1' })
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1', 'My feature')]}
        tasks={[t1]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-testid="proposal-node-subgraph"')
  })

  it('renders the proposal node in the subgraph', () => {
    const t1 = task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[t1]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-node-id="p1"')
    expect(html).toContain('data-node-kind="proposal"')
  })

  it('renders each sliced task node in the subgraph', () => {
    const t1 = task({ id: 't1', cluster: 'In progress', parentProposalId: 'p1' })
    const t2 = task({ id: 't2', cluster: 'Queued', parentProposalId: 'p1' })
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[t1, t2]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-node-id="t1"')
    expect(html).toContain('data-node-id="t2"')
  })

  it('excludes tasks that belong to other proposals', () => {
    const t1 = task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })
    const t2 = task({ id: 't2', cluster: 'Queued', parentProposalId: 'p2' })
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[t1, t2]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-node-id="t1"')
    expect(html).not.toContain('data-node-id="t2"')
  })

  it('excludes tasks that have no parentProposalId', () => {
    const t1 = task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })
    const t2 = task({ id: 't2', cluster: 'In progress', parentProposalId: null })
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[t1, t2]}
        onClose={() => {}}
      />,
    )
    expect(html).not.toContain('data-node-id="t2"')
  })

  it('renders provenance edges from the proposal to its sliced tasks', () => {
    const t1 = task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[t1]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-edge-kind="provenance"')
  })

  it('renders the proposal node alone when no tasks are sliced from it', () => {
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[task({ id: 'other', cluster: 'Queued', parentProposalId: null })]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-node-id="p1"')
    expect(html).not.toContain('data-node-id="other"')
    expect(html).not.toContain('data-edge-kind="provenance"')
  })
})

// ── AC4: Clicking a sliced-task node swaps to that task ───────────────────────

describe('ProposalNodeDrawer – task node drill-in', () => {
  it('each sliced-task node in the subgraph links to the task drawer', () => {
    const t1 = task({ id: 'mars-abc123', cluster: 'In progress', parentProposalId: 'p1' })
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[t1]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('href="#/task/mars-abc123"')
  })

  it('URL-encodes special characters in the task id within the drill-in link', () => {
    const t1 = task({ id: 'task/id with spaces', cluster: 'Queued', parentProposalId: 'p1' })
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[t1]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('href="#/task/task%2Fid%20with%20spaces"')
  })

  it('links to each sliced task when multiple tasks are present', () => {
    const t1 = task({ id: 'task-a', cluster: 'Queued', parentProposalId: 'p1' })
    const t2 = task({ id: 'task-b', cluster: 'In progress', parentProposalId: 'p1' })
    const html = renderToStaticMarkup(
      <ProposalNodeDrawer
        proposalId="p1"
        proposals={[proposal('p1')]}
        tasks={[t1, t2]}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('href="#/task/task-a"')
    expect(html).toContain('href="#/task/task-b"')
  })
})
