import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import { TopologyView } from './TopologyView'

const task = (
  overrides: Partial<ProgressTask> & { id: string; cluster: ProgressTask['cluster'] },
): ProgressTask => ({
  id: overrides.id,
  prompt: overrides.prompt ?? `Task ${overrides.id}`,
  status: overrides.status ?? 'running',
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

const proposal = (id: string, goal = `Goal ${id}`): ProgressProposalNode => ({
  id,
  goal,
  source: 'human',
  status: 'draft',
})

describe('TopologyView – empty state', () => {
  it('renders without error when there are no tasks or proposals', () => {
    const html = renderToStaticMarkup(<TopologyView tasks={[]} proposals={[]} />)
    expect(html.length).toBeGreaterThan(0)
  })

  it('shows an empty-state message when there is nothing to display', () => {
    const html = renderToStaticMarkup(<TopologyView tasks={[]} proposals={[]} />)
    expect(html.toLowerCase()).toMatch(/no task|empty|nothing|no active/i)
  })
})

describe('TopologyView – task node colouring from server cluster', () => {
  it('marks a Blocked task node as gray via a data-cluster attribute', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't-blocked', cluster: 'Blocked', status: 'blocked' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-cluster="Blocked"')
  })

  it('marks a Failed task node as red via a data-cluster attribute', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't-failed', cluster: 'Failed', status: 'failed' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-cluster="Failed"')
  })

  it('marks an In-progress task node with its cluster via a data-cluster attribute', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't-running', cluster: 'In progress', status: 'running' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-cluster="In progress"')
  })

  it('carries the cluster value directly from the task without recomputing it', () => {
    // If the server says 'Blocked', the node must show 'Blocked' regardless of status.
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't-mismatch', cluster: 'Blocked', status: 'running' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-cluster="Blocked"')
    expect(html).not.toContain('data-cluster="In progress"')
  })
})

describe('TopologyView – proposal nodes', () => {
  it('renders a node for each in-scope proposal', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't1', cluster: 'In progress', parentProposalId: 'p1' })]}
        proposals={[proposal('p1', 'My feature goal')]}
      />,
    )
    expect(html).toContain('data-node-kind="proposal"')
  })

  it('renders no proposal node when proposals array is empty', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't1', cluster: 'In progress' })]}
        proposals={[]}
      />,
    )
    expect(html).not.toContain('data-node-kind="proposal"')
  })
})

describe('TopologyView – blocker edges', () => {
  it('renders an edge element between a blocker and its dependent', () => {
    const blocker = task({ id: 'blocker', cluster: 'In progress' })
    const dependent = task({ id: 'dependent', cluster: 'Blocked', blockedBy: ['blocker'] })
    const html = renderToStaticMarkup(
      <TopologyView tasks={[blocker, dependent]} proposals={[]} />,
    )
    // An SVG path or line element should be present for the edge
    expect(html).toMatch(/data-edge-kind="blocker"/)
  })

  it('does not render a blocker edge when no task has blockedBy entries', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[
          task({ id: 't1', cluster: 'In progress' }),
          task({ id: 't2', cluster: 'Queued' }),
        ]}
        proposals={[]}
      />,
    )
    expect(html).not.toMatch(/data-edge-kind="blocker"/)
  })
})

describe('TopologyView – provenance edges', () => {
  it('renders a provenance edge from proposal to sliced task', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't1', cluster: 'In progress', parentProposalId: 'p1' })]}
        proposals={[proposal('p1')]}
      />,
    )
    expect(html).toMatch(/data-edge-kind="provenance"/)
  })

  it('does not render provenance edges when no task has a parentProposalId', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't1', cluster: 'In progress', parentProposalId: null })]}
        proposals={[proposal('p1')]}
      />,
    )
    expect(html).not.toMatch(/data-edge-kind="provenance"/)
  })
})
