import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import { TaskDetailDrawer } from './TaskDetailDrawer'

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

// ── Identity tests (pre-existing) ─────────────────────────────────────────────

/**
 * The TaskDetailDrawer is the single detail surface for task nodes on the
 * Progress tab.  Both the DAG (TopologyView) and the column view (BoardView /
 * TaskCard) navigate to `#/task/<id>`, and App.tsx mounts exactly one
 * TaskDetailDrawer in response.  These tests verify that the component has a
 * consistent, identifiable structure — "same drawer" criterion.
 */
describe('TaskDetailDrawer – identity (same surface from both views)', () => {
  it('renders a dialog with the task-detail-drawer testid', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="task-detail-drawer"')
    expect(html).toContain('role="dialog"')
  })

  it('displays the task id in the drawer heading', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('mars-abc123')
  })

  it('exposes a close control via data-testid', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="task-detail-close"')
  })

  it('renders the same drawer structure regardless of which task id is passed', () => {
    const html1 = renderToStaticMarkup(
      <TaskDetailDrawer taskId="task-from-dag" onClose={() => {}} />,
    )
    const html2 = renderToStaticMarkup(
      <TaskDetailDrawer taskId="task-from-board" onClose={() => {}} />,
    )
    // Both render the same structural shell (dialog role, same testids).
    expect(html1).toContain('role="dialog"')
    expect(html2).toContain('role="dialog"')
    expect(html1).toContain('data-testid="task-detail-drawer"')
    expect(html2).toContain('data-testid="task-detail-drawer"')
    expect(html1).toContain('data-testid="task-detail-close"')
    expect(html2).toContain('data-testid="task-detail-close"')
  })
})

// ── Subgraph: isolated task ───────────────────────────────────────────────────

describe('TaskDetailDrawer – subgraph (isolated task)', () => {
  it('renders the subgraph section and the focused task node when the task has no neighbours', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="task-solo"
        onClose={() => {}}
        tasks={[task({ id: 'task-solo', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-testid="task-detail-subgraph"')
    expect(html).toContain('data-node-id="task-solo"')
  })

  it('renders exactly one node when the task has no blockers, dependents, or proposal', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="task-solo"
        onClose={() => {}}
        tasks={[task({ id: 'task-solo', cluster: 'In progress' })]}
        proposals={[]}
      />,
    )
    const nodeCount = (html.match(/data-node-id=/g) ?? []).length
    expect(nodeCount).toBe(1)
  })

  it('does not render the subgraph section when tasks prop is not provided', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="task-solo" onClose={() => {}} />,
    )
    expect(html).not.toContain('data-testid="task-detail-subgraph"')
  })
})

// ── Subgraph: upstream blocker chain ─────────────────────────────────────────

describe('TaskDetailDrawer – subgraph (upstream blockers)', () => {
  it('includes a direct upstream blocker in the subgraph', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'blocker', cluster: 'In progress' }),
          task({ id: 'focus', cluster: 'Blocked', blockedBy: ['blocker'] }),
        ]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-node-id="blocker"')
    expect(html).toContain('data-node-id="focus"')
  })

  it('includes the full upstream chain back to the root', () => {
    // root → mid → focus
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'root', cluster: 'Queued' }),
          task({ id: 'mid', cluster: 'In progress', blockedBy: ['root'] }),
          task({ id: 'focus', cluster: 'Blocked', blockedBy: ['mid'] }),
        ]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-node-id="root"')
    expect(html).toContain('data-node-id="mid"')
    expect(html).toContain('data-node-id="focus"')
  })

  it('renders a blocker edge between the upstream blocker and the focused task', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'blocker', cluster: 'In progress' }),
          task({ id: 'focus', cluster: 'Blocked', blockedBy: ['blocker'] }),
        ]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-edge-kind="blocker"')
  })

  it('excludes tasks unrelated to the focused task', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'focus', cluster: 'Queued' }),
          task({ id: 'unrelated', cluster: 'In progress' }),
        ]}
        proposals={[]}
      />,
    )
    expect(html).not.toContain('data-node-id="unrelated"')
  })
})

// ── Subgraph: one-hop downstream dependents ───────────────────────────────────

describe('TaskDetailDrawer – subgraph (downstream dependents)', () => {
  it('includes the immediate (one-hop) downstream dependent', () => {
    // focus → child → grandchild; only child should appear
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'focus', cluster: 'In progress' }),
          task({ id: 'child', cluster: 'Blocked', blockedBy: ['focus'] }),
          task({ id: 'grandchild', cluster: 'Queued', blockedBy: ['child'] }),
        ]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-node-id="child"')
    expect(html).not.toContain('data-node-id="grandchild"')
  })
})

// ── Subgraph: originating proposal ───────────────────────────────────────────

describe('TaskDetailDrawer – subgraph (originating proposal)', () => {
  it('includes the originating proposal node when one exists', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[task({ id: 'focus', cluster: 'Queued', parentProposalId: 'prop-1' })]}
        proposals={[proposal('prop-1', 'Ship the feature')]}
      />,
    )
    expect(html).toContain('data-node-id="prop-1"')
    expect(html).toContain('data-node-kind="proposal"')
  })

  it('renders a provenance edge from the proposal to the focused task', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[task({ id: 'focus', cluster: 'Queued', parentProposalId: 'prop-1' })]}
        proposals={[proposal('prop-1')]}
      />,
    )
    expect(html).toContain('data-edge-kind="provenance"')
  })

  it('does not include other tasks sliced from the same proposal', () => {
    // prop-1 also sliced "sibling"; the drawer should not pull sibling in
    // via the proposal — it is not upstream, downstream, or provenance of focus.
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="focus"
        onClose={() => {}}
        tasks={[
          task({ id: 'focus', cluster: 'Queued', parentProposalId: 'prop-1' }),
          task({ id: 'sibling', cluster: 'Queued', parentProposalId: 'prop-1' }),
        ]}
        proposals={[proposal('prop-1')]}
      />,
    )
    expect(html).not.toContain('data-node-id="sibling"')
  })
})

// ── A11y: scrim + focusable drawer ───────────────────────────────────────────

/**
 * These tests verify the static HTML structure that enables the keyboard /
 * pointer a11y behaviours (Escape-to-close, outside-click dismiss, focus trap,
 * focus restoration).  The interactive side of those behaviours (actual key
 * events and focus movement) requires a live DOM and is covered by the Manual
 * verification steps in the task spec.
 */
describe('TaskDetailDrawer – a11y overlay and focusability', () => {
  it('renders a scrim overlay element alongside the drawer panel', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="task-detail-overlay"')
  })

  it('scrim is aria-hidden so it does not pollute the screen reader tree', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('aria-hidden="true"')
  })

  it('scrim uses z-40 (lower than the drawer z-50) so the drawer stays on top', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('z-40')
    expect(html).toContain('z-50')
  })

  it('drawer panel has tabindex="-1" so it can receive programmatic focus on open', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('tabindex="-1"')
  })
})

// ── Drawer entrance animation ────────────────────────────────────────────────

/**
 * These tests verify the static HTML structure that enables the CSS entrance
 * and exit animations.  The actual motion (transform/opacity transitions) is a
 * browser concern and is not exercised in unit tests; these tests confirm that
 * the CSS anchor classes and data attributes are present in the rendered markup.
 */
describe('TaskDetailDrawer – entrance / exit animation structure', () => {
  it('aside panel carries the drawer-panel CSS class (entrance animation anchor)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('drawer-panel')
  })

  it('scrim carries the drawer-scrim CSS class (scrim fade anchor)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).toContain('drawer-scrim')
  })

  it('data-closing is absent on initial render — exit animation not yet active', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer taskId="mars-abc123" onClose={() => {}} />,
    )
    expect(html).not.toContain('data-closing="true"')
  })
})

// ── Subgraph: cluster colours match main canvas ───────────────────────────────

describe('TaskDetailDrawer – subgraph (cluster colours match main canvas)', () => {
  it('colours a Queued task node with the Queued palette (same as TopologyView)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued' })]}
        proposals={[]}
      />,
    )
    // Colours are now CSS design-token references so both canvases stay in sync.
    expect(html).toContain('var(--color-dag-queued-fill)')
    expect(html).toContain('var(--color-dag-queued-stroke)')
  })

  it('colours a Failed task node with the Failed palette (same as TopologyView)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Failed', status: 'failed' })]}
        proposals={[]}
      />,
    )
    // Colours are now CSS design-token references so both canvases stay in sync.
    expect(html).toContain('var(--color-dag-failed-fill)')
    expect(html).toContain('var(--color-dag-failed-stroke)')
  })

  it('colours a Blocked task node with the Blocked palette (same as TopologyView)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Blocked', status: 'blocked' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('var(--color-dag-blocked-fill)')
    expect(html).toContain('var(--color-dag-blocked-stroke)')
  })

  it('colours an In progress task node with the In progress palette (same as TopologyView)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'In progress', status: 'running' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('var(--color-dag-in-progress-fill)')
    expect(html).toContain('var(--color-dag-in-progress-stroke)')
  })

  it('colours a proposal node with the purple proposal palette (same as TopologyView)', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Queued', parentProposalId: 'p1' })]}
        proposals={[proposal('p1')]}
      />,
    )
    expect(html).toContain('var(--color-dag-proposal-fill)')
    expect(html).toContain('var(--color-dag-proposal-stroke)')
  })

  it('attaches data-cluster to task nodes for cluster identification', () => {
    const html = renderToStaticMarkup(
      <TaskDetailDrawer
        taskId="t1"
        onClose={() => {}}
        tasks={[task({ id: 't1', cluster: 'Failed', status: 'failed' })]}
        proposals={[]}
      />,
    )
    expect(html).toContain('data-cluster="Failed"')
  })
})
