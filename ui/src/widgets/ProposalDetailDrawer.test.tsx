import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProposalDetailDrawer } from './ProposalDetailDrawer'
import type { DraftFeature, ProgressTask } from '@/shared/schemas'

const draftProposal = (overrides: Partial<DraftFeature> = {}): DraftFeature => ({
  id: 'prop-1',
  title: 'Fill in the Proposal drawer content',
  problem: '',
  solution: '',
  status: 'draft',
  source: 'reflection',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  acceptanceCount: 3,
  userStories: [],
  ...overrides,
})

const makeTask = (
  id: string,
  overrides: Partial<ProgressTask> = {},
): ProgressTask => ({
  id,
  prompt: `Task prompt for ${id}`,
  status: 'done',
  plan: null,
  branch: null,
  worktreePath: null,
  error: null,
  dropReason: null,
  recoverySpawnedCount: 0,
  blockerTaskId: null,
  blockedBy: [],
  parentProposalId: null,
  spec: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  cluster: 'Queued',
  ...overrides,
})

describe('ProposalDetailDrawer', () => {
  it('renders the proposal title, status badge, and source', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )

    // Title at the top of the drawer.
    expect(html).toContain('Fill in the Proposal drawer content')

    // Status badge reflects the draft status with legend-matching styling.
    expect(html).toContain('data-testid="proposal-detail-status"')
    expect(html).toContain('draft')
    expect(html).toContain('font-mono')

    // Source label is visible.
    expect(html).toContain('data-testid="proposal-detail-source"')
    expect(html).toContain('reflection')
  })

  it('reflects a non-draft status and a different source', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ status: 'prd-ready', source: 'planner' })}
        onClose={() => {}}
      />,
    )

    expect(html).toContain('prd-ready')
    expect(html).toContain('planner')
  })
})

// ── Drawer entrance animation ────────────────────────────────────────────────

describe('ProposalDetailDrawer – entrance / exit animation structure', () => {
  it('aside panel carries the drawer-panel CSS class (entrance animation anchor)', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).toContain('drawer-panel')
  })

  it('scrim carries the drawer-scrim CSS class (scrim fade anchor)', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).toContain('drawer-scrim')
  })

  it('data-closing is absent on initial render — exit animation not yet active', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).not.toContain('data-closing="true"')
  })
})

// ── CLI commands section ─────────────────────────────────────────────────────

describe('ProposalDetailDrawer – CLI commands section', () => {
  it('draft proposal shows promote and show commands with real id substituted', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ id: 'prop-abc', status: 'draft' })}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('mars proposal promote prop-abc')
    expect(html).toContain('mars proposal show prop-abc')
  })

  it('prd-ready proposal shows slice and show commands with real id substituted', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ id: 'prop-xyz', status: 'prd-ready' })}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('mars proposal slice prop-xyz')
    expect(html).toContain('mars proposal show prop-xyz')
  })

  it('sliced proposal shows only the show command', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ id: 'prop-sliced', status: 'sliced' })}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('mars proposal show prop-sliced')
    expect(html).not.toContain('mars proposal promote')
    expect(html).not.toContain('mars proposal slice prop-sliced')
  })

  it('dismissed proposal shows only the show command', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ id: 'prop-dismissed', status: 'dismissed' })}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('mars proposal show prop-dismissed')
    expect(html).not.toContain('mars proposal promote')
    expect(html).not.toContain('mars proposal slice')
  })

  it('each command has a copy-to-clipboard affordance', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ id: 'prop-1', status: 'draft' })}
        onClose={() => {}}
      />,
    )
    // draft has 2 commands → 2 copy buttons
    const copyCount = (html.match(/data-testid="copy-cli-cmd"/g) ?? []).length
    expect(copyCount).toBe(2)
  })

  it('no mutation buttons appear in the drawer for any status', () => {
    const statuses = ['draft', 'prd-ready', 'sliced', 'dismissed']
    for (const status of statuses) {
      const html = renderToStaticMarkup(
        <ProposalDetailDrawer
          proposal={draftProposal({ status })}
          onClose={() => {}}
        />,
      )
      expect(html).not.toContain('data-testid="btn-promote"')
      expect(html).not.toContain('data-testid="btn-reject"')
      expect(html).not.toContain('data-testid="btn-slice"')
    }
  })
})

// ── A11y: scrim + focusable drawer ───────────────────────────────────────────

/**
 * Same structural checks as TaskDetailDrawer – the two drawers share the same
 * a11y contract (scrim, focus-trap infrastructure, Escape-to-close).
 */
describe('ProposalDetailDrawer – a11y overlay and focusability', () => {
  it('renders a scrim overlay element alongside the drawer panel', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="proposal-detail-overlay"')
  })

  it('scrim is aria-hidden so it does not pollute the screen reader tree', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).toContain('aria-hidden="true"')
  })

  it('scrim uses z-40 (lower than the drawer z-50) so the drawer stays on top', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).toContain('z-40')
    expect(html).toContain('z-50')
  })

  it('drawer panel has tabindex="-1" so it can receive programmatic focus on open', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).toContain('tabindex="-1"')
  })
})

// ── Sliced-tasks list section ────────────────────────────────────────────────

describe('ProposalDetailDrawer – sliced-tasks list', () => {
  const slicedProposal = draftProposal({ id: 'prop-sliced', status: 'sliced' })

  const tasks: ProgressTask[] = [
    makeTask('task-alpha', {
      parentProposalId: 'prop-sliced',
      status: 'done',
      prompt: 'Alpha task title\nsome extra detail that should be ignored',
    }),
    makeTask('task-beta', {
      parentProposalId: 'prop-sliced',
      status: 'running',
      prompt: 'Beta task title',
    }),
    makeTask('task-other', {
      parentProposalId: 'other-prop',
      status: 'done',
      prompt: 'Unrelated task',
    }),
  ]

  it('renders child task ids, statuses, and first-line titles for a sliced proposal', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={slicedProposal} onClose={() => {}} tasks={tasks} />,
    )
    // Both child tasks appear.
    expect(html).toContain('task-alpha')
    expect(html).toContain('Alpha task title')
    expect(html).toContain('task-beta')
    expect(html).toContain('Beta task title')
    // Unrelated task is excluded.
    expect(html).not.toContain('task-other')
    expect(html).not.toContain('Unrelated task')
  })

  it('each child task entry links to the task hash to focus that row', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={slicedProposal} onClose={() => {}} tasks={tasks} />,
    )
    expect(html).toContain('#/task/task-alpha')
    expect(html).toContain('#/task/task-beta')
  })

  it('shows the status of each child task', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={slicedProposal} onClose={() => {}} tasks={tasks} />,
    )
    expect(html).toContain('done')
    expect(html).toContain('running')
  })

  it('does not render the sliced-tasks section for non-sliced proposals', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ status: 'draft' })}
        onClose={() => {}}
        tasks={tasks}
      />,
    )
    expect(html).not.toContain('data-testid="sliced-tasks"')
    expect(html).not.toContain('task-alpha')
    expect(html).not.toContain('task-beta')
  })

  it('does not render the sliced-tasks section for prd-ready proposals', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ status: 'prd-ready' })}
        onClose={() => {}}
        tasks={tasks}
      />,
    )
    expect(html).not.toContain('data-testid="sliced-tasks"')
  })

  it('only shows the first line of the prompt as the task title', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={slicedProposal} onClose={() => {}} tasks={tasks} />,
    )
    // The second line of the alpha prompt should NOT appear.
    expect(html).not.toContain('some extra detail that should be ignored')
  })
})

// ── Body sections: problem, solution, user stories ───────────────────────────

describe('ProposalDetailDrawer – body sections', () => {
  it('renders the problem statement when non-empty', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ problem: 'The drawer shows nothing useful.' })}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-testid="proposal-detail-problem"')
    expect(html).toContain('The drawer shows nothing useful.')
  })

  it('renders the solution / PRD body when non-empty', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ solution: 'Render problem, solution, and user stories.' })}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-testid="proposal-detail-solution"')
    expect(html).toContain('Render problem, solution, and user stories.')
  })

  it('renders the user stories list when stories are present', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ userStories: ['Story alpha', 'Story beta'] })}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-testid="proposal-detail-stories"')
    expect(html).toContain('Story alpha')
    expect(html).toContain('Story beta')
  })

  it('omits the problem section when problem is empty', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ problem: '' })}
        onClose={() => {}}
      />,
    )
    expect(html).not.toContain('data-testid="proposal-detail-problem"')
  })

  it('omits the solution section when solution is empty', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ solution: '' })}
        onClose={() => {}}
      />,
    )
    expect(html).not.toContain('data-testid="proposal-detail-solution"')
  })

  it('omits the user stories section when no stories exist', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ userStories: [] })}
        onClose={() => {}}
      />,
    )
    expect(html).not.toContain('data-testid="proposal-detail-stories"')
  })

  it('renders all three sections when all content is present', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({
          problem: 'Users see an empty panel.',
          solution: 'Fill the panel with PRD content.',
          userStories: ['User sees the problem', 'User sees the solution'],
        })}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-testid="proposal-detail-problem"')
    expect(html).toContain('data-testid="proposal-detail-solution"')
    expect(html).toContain('data-testid="proposal-detail-stories"')
    expect(html).toContain('Users see an empty panel.')
    expect(html).toContain('Fill the panel with PRD content.')
    expect(html).toContain('User sees the problem')
    expect(html).toContain('User sees the solution')
  })
})
