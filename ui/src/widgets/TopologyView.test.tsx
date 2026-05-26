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

const proposal = (id: string, title = `Goal ${id}`): ProgressProposalNode => ({
  id,
  title,
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

describe('TopologyView – proposal filter (ghost non-matching nodes)', () => {
  it('ghosts task nodes that do not belong to the selected proposal', () => {
    const t1 = task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })
    const t2 = task({ id: 't2', cluster: 'Queued', parentProposalId: null })
    const html = renderToStaticMarkup(
      <TopologyView tasks={[t1, t2]} proposals={[]} selectedProposalId="p1" />,
    )
    expect(html).toContain('data-ghosted="true"')
  })

  it('does not ghost the task that belongs to the selected proposal', () => {
    const t1 = task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })
    const t2 = task({ id: 't2', cluster: 'Queued', parentProposalId: null })
    const p1 = proposal('p1', 'Feature A')
    // Only render t1 + p1 (both match p1); t2 would be ghosted but is absent here
    const html = renderToStaticMarkup(
      <TopologyView tasks={[t1]} proposals={[p1]} selectedProposalId="p1" />,
    )
    expect(html).not.toContain('data-ghosted="true"')
  })

  it('does not ghost the selected proposal node itself', () => {
    const t1 = task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })
    const p1 = proposal('p1', 'Feature A')
    const html = renderToStaticMarkup(
      <TopologyView tasks={[t1]} proposals={[p1]} selectedProposalId="p1" />,
    )
    expect(html).not.toContain('data-ghosted="true"')
  })

  it('ghosts non-selected proposal nodes when a proposal is selected', () => {
    const t1 = task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })
    const t2 = task({ id: 't2', cluster: 'Queued', parentProposalId: 'p2' })
    const p1 = proposal('p1', 'Feature A')
    const p2 = proposal('p2', 'Feature B')
    const html = renderToStaticMarkup(
      <TopologyView tasks={[t1, t2]} proposals={[p1, p2]} selectedProposalId="p1" />,
    )
    expect(html).toContain('data-ghosted="true"')
  })

  it('renders all nodes without ghosting when selectedProposalId is null', () => {
    const t1 = task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })
    const p1 = proposal('p1', 'Feature A')
    const html = renderToStaticMarkup(
      <TopologyView tasks={[t1]} proposals={[p1]} selectedProposalId={null} />,
    )
    expect(html).not.toContain('data-ghosted="true"')
  })

  it('does not reflow the layout when a filter is active (positions are unchanged)', () => {
    const t1 = task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })
    const t2 = task({ id: 't2', cluster: 'Queued', parentProposalId: 'p2' })
    const p1 = proposal('p1', 'Feature A')
    const htmlFiltered = renderToStaticMarkup(
      <TopologyView tasks={[t1, t2]} proposals={[p1]} selectedProposalId="p1" />,
    )
    const htmlUnfiltered = renderToStaticMarkup(
      <TopologyView tasks={[t1, t2]} proposals={[p1]} selectedProposalId={null} />,
    )
    // Extract translate values — same node count means same layout
    const translates = (h: string) => h.match(/translate\([^)]+\)/g) ?? []
    expect(translates(htmlFiltered)).toEqual(translates(htmlUnfiltered))
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

describe('TopologyView – cluster ghosting', () => {
  it('ghosts a task node whose cluster is in ghostedClusters', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't1', cluster: 'Blocked', status: 'blocked' })]}
        proposals={[]}
        ghostedClusters={new Set(['Blocked'])}
      />,
    )
    expect(html).toContain('data-ghosted="true"')
  })

  it('does not ghost a task node whose cluster is not in ghostedClusters', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't1', cluster: 'In progress', status: 'running' })]}
        proposals={[]}
        ghostedClusters={new Set(['Blocked'])}
      />,
    )
    expect(html).not.toContain('data-ghosted="true"')
  })

  it('ghosts a proposal node when "Proposal" is in ghostedClusters', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't1', cluster: 'In progress', parentProposalId: 'p1' })]}
        proposals={[proposal('p1', 'My goal')]}
        ghostedClusters={new Set(['Proposal'])}
      />,
    )
    expect(html).toContain('data-ghosted="true"')
  })

  it('does not ghost task nodes when only "Proposal" is in ghostedClusters', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't1', cluster: 'In progress', status: 'running' })]}
        proposals={[]}
        ghostedClusters={new Set(['Proposal'])}
      />,
    )
    expect(html).not.toContain('data-ghosted="true"')
  })

  it('does not ghost any nodes when ghostedClusters is empty', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't1', cluster: 'Failed', status: 'failed' })]}
        proposals={[proposal('p1')]}
        ghostedClusters={new Set()}
      />,
    )
    expect(html).not.toContain('data-ghosted="true"')
  })

  it('does not ghost any nodes when ghostedClusters is not provided', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't1', cluster: 'Failed', status: 'failed' })]}
        proposals={[proposal('p1')]}
      />,
    )
    expect(html).not.toContain('data-ghosted="true"')
  })

  it('ghosts multiple clusters simultaneously', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[
          task({ id: 't1', cluster: 'In progress', status: 'running' }),
          task({ id: 't2', cluster: 'Blocked', status: 'blocked' }),
          task({ id: 't3', cluster: 'Failed', status: 'failed' }),
        ]}
        proposals={[]}
        ghostedClusters={new Set(['Blocked', 'Failed'])}
      />,
    )
    const ghostedCount = (html.match(/data-ghosted="true"/g) ?? []).length
    expect(ghostedCount).toBe(2)
    expect(html).not.toContain('data-cluster="In progress" data-ghosted')
  })
})

describe('TopologyView – task node drawer link', () => {
  it('each task node is wrapped in a link to the task drawer', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 'mars-abc123', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('href="#/task/mars-abc123"')
  })

  it('URL-encodes special characters in the task id within the drawer link', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 'mars/task id', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('href="#/task/mars%2Ftask%20id"')
  })

  it('does not create a task-drawer link for proposal nodes', () => {
    const html = renderToStaticMarkup(
      <TopologyView
        tasks={[task({ id: 't1', cluster: 'In progress', parentProposalId: 'p1' })]}
        proposals={[proposal('p1')]}
      />,
    )
    expect(html).not.toContain('href="#/task/p1"')
  })
})
