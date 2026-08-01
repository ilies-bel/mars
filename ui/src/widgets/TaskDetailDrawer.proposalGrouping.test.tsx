/**
 * Slice-4 tests: proposal-mode grouped step timeline in TaskDetailDrawer.
 *
 * When the drawer is opened on a PROPOSAL node, the Steps panel renders:
 *   1. A 'Proposal steps' group (data-testid="step-group-proposal") for spans
 *      with span.taskId === null.  Inside it, spans whose stepName is
 *      'auto-linker-direction' collapse by default into a summary row showing
 *      count and total duration; other proposal spans render normally.
 *   2. One section per distinct non-null taskId in insertion order, each with
 *      data-testid="step-group-<taskId>", a header that includes the task id
 *      and step count, and the spine spans expanded by default.
 *
 * Task-mode rendering (slice 3) is completely unaffected — these tests verify
 * only the proposal-mode path.
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import type { StepSpan } from './TaskDetailDrawer'
import { TaskDetailDrawer } from './TaskDetailDrawer'

// ── Test helper ──────────────────────────────────────────────────────────────

const render = (element: React.ReactElement): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>{element}</QueryClientProvider>,
  )
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const makeTask = (
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

const makeProposal = (id: string, title = `Goal ${id}`): ProgressProposalNode => ({
  id,
  title,
  source: 'human',
  status: 'prd-ready',
})

const makeSpan = (overrides: Partial<StepSpan> & { stepName: string }): StepSpan => ({
  stepName: overrides.stepName,
  phase: null,
  workflowInstanceId: overrides.workflowInstanceId ?? 'wf-test',
  workerName: null,
  outcome: overrides.outcome ?? 'completed',
  startedAt: '2026-01-01T10:00:00.000Z',
  endedAt: '2026-01-01T10:00:01.000Z',
  durationMs: overrides.durationMs ?? 1000,
  taskId: overrides.taskId ?? null,
  originId: overrides.originId ?? 'prop-x',
  ...overrides,
})

// ── Proposal mode: group structure ───────────────────────────────────────────

describe('TaskDetailDrawer – proposal grouping (slice-4)', () => {
  const proposalId = 'prop-x'
  const taskAId = 'mars-22427f4d'
  const taskBId = 'mars-aabbcc11'

  // Simulate a typical proposal arc:
  //   - Proposal-level spans (taskId=null): generate-slices, auto-linker-direction × 2
  //   - Task A spans: setup-worktree, run-claude-code, verify, merge
  //   - Task B spans: setup-worktree, run-claude-code
  const arcSpans: StepSpan[] = [
    makeSpan({ stepName: 'generate-slices', taskId: null, durationMs: 500 }),
    makeSpan({ stepName: 'auto-linker-direction', taskId: null, durationMs: 300, workflowInstanceId: 'wf-al-1' }),
    makeSpan({ stepName: 'auto-linker-direction', taskId: null, durationMs: 400, workflowInstanceId: 'wf-al-2' }),
    makeSpan({ stepName: 'setup-worktree', taskId: taskAId, workflowInstanceId: 'wf-a' }),
    makeSpan({ stepName: 'run-claude-code', taskId: taskAId, workflowInstanceId: 'wf-a' }),
    makeSpan({ stepName: 'verify', taskId: taskAId, workflowInstanceId: 'wf-a' }),
    makeSpan({ stepName: 'merge', taskId: taskAId, workflowInstanceId: 'wf-a' }),
    makeSpan({ stepName: 'setup-worktree', taskId: taskBId, workflowInstanceId: 'wf-b' }),
    makeSpan({ stepName: 'run-claude-code', taskId: taskBId, workflowInstanceId: 'wf-b', outcome: 'running', endedAt: null, durationMs: null }),
  ]

  it('renders a step-group-proposal section for spans with null taskId', () => {
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[
          makeTask({ id: taskAId, cluster: 'Done', parentProposalId: proposalId }),
          makeTask({ id: taskBId, cluster: 'In progress', parentProposalId: proposalId }),
        ]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={arcSpans}
      />,
    )
    expect(html).toContain('data-testid="step-group-proposal"')
  })

  it('renders one step-group section per distinct non-null taskId', () => {
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[
          makeTask({ id: taskAId, cluster: 'Done', parentProposalId: proposalId }),
          makeTask({ id: taskBId, cluster: 'In progress', parentProposalId: proposalId }),
        ]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={arcSpans}
      />,
    )
    expect(html).toContain(`data-testid="step-group-${taskAId}"`)
    expect(html).toContain(`data-testid="step-group-${taskBId}"`)
  })

  it('step-group-proposal appears before child-task groups in document order', () => {
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[
          makeTask({ id: taskAId, cluster: 'Done', parentProposalId: proposalId }),
        ]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={arcSpans}
      />,
    )
    const proposalIdx = html.indexOf('step-group-proposal')
    const taskAIdx = html.indexOf(`step-group-${taskAId}`)
    expect(proposalIdx).toBeGreaterThanOrEqual(0)
    expect(taskAIdx).toBeGreaterThanOrEqual(0)
    expect(proposalIdx).toBeLessThan(taskAIdx)
  })

  it('child-task group header text includes the task id', () => {
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[
          makeTask({ id: taskAId, cluster: 'Done', parentProposalId: proposalId }),
        ]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={arcSpans}
      />,
    )
    // The header for the task-A group must contain the task id string.
    const taskGroupStart = html.indexOf(`step-group-${taskAId}`)
    const taskGroupSnippet = html.slice(taskGroupStart, taskGroupStart + 300)
    expect(taskGroupSnippet).toContain(taskAId)
  })

  it('child-task group header includes the step count for that task', () => {
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[
          makeTask({ id: taskAId, cluster: 'Done', parentProposalId: proposalId }),
        ]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={arcSpans}
      />,
    )
    // Task A has 4 spans (setup-worktree, run-claude-code, verify, merge).
    const taskGroupStart = html.indexOf(`step-group-${taskAId}`)
    const taskGroupSnippet = html.slice(taskGroupStart, taskGroupStart + 300)
    expect(taskGroupSnippet).toContain('4')
  })

  it('proposal-mode: spans routed to correct groups by taskId', () => {
    // generate-slices (taskId=null) → proposal group
    // setup-worktree (taskId=taskAId) → taskA group
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[makeTask({ id: taskAId, cluster: 'Done', parentProposalId: proposalId })]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={arcSpans}
      />,
    )
    // generate-slices appears inside the proposal group section
    const proposalGroupEnd = html.indexOf(`step-group-${taskAId}`)
    const proposalGroupHtml = html.slice(0, proposalGroupEnd)
    expect(proposalGroupHtml).toContain('generate-slices')

    // setup-worktree appears inside taskA's section (after the proposal group)
    const taskGroupHtml = html.slice(proposalGroupEnd)
    expect(taskGroupHtml).toContain('setup-worktree')
  })
})

// ── Proposal mode: auto-linker-direction collapsing ───────────────────────────

describe('TaskDetailDrawer – auto-linker-direction collapsing in proposal group', () => {
  const proposalId = 'prop-x'

  it('auto-linker-direction spans are wrapped in a collapsible container (collapsed by default)', () => {
    const spans: StepSpan[] = [
      makeSpan({ stepName: 'auto-linker-direction', taskId: null, durationMs: 300, workflowInstanceId: 'wf-al-1' }),
      makeSpan({ stepName: 'auto-linker-direction', taskId: null, durationMs: 400, workflowInstanceId: 'wf-al-2' }),
    ]
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={spans}
      />,
    )
    // The container must have open={false} (i.e. no 'open' attribute on <details>)
    // which means it is collapsed by default.
    expect(html).toContain('<details')
    expect(html).not.toContain('<details open')
  })

  it('collapsed auto-linker-direction summary shows span count', () => {
    const spans: StepSpan[] = [
      makeSpan({ stepName: 'auto-linker-direction', taskId: null, durationMs: 300, workflowInstanceId: 'wf-al-1' }),
      makeSpan({ stepName: 'auto-linker-direction', taskId: null, durationMs: 400, workflowInstanceId: 'wf-al-2' }),
      makeSpan({ stepName: 'auto-linker-direction', taskId: null, durationMs: 200, workflowInstanceId: 'wf-al-3' }),
    ]
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={spans}
      />,
    )
    // Summary must show count of 3
    expect(html).toContain('3')
    // Must mention the step kind
    expect(html).toContain('auto-linker-direction')
  })

  it('collapsed auto-linker-direction summary shows total duration', () => {
    const spans: StepSpan[] = [
      makeSpan({ stepName: 'auto-linker-direction', taskId: null, durationMs: 300, workflowInstanceId: 'wf-al-1' }),
      makeSpan({ stepName: 'auto-linker-direction', taskId: null, durationMs: 700, workflowInstanceId: 'wf-al-2' }),
    ]
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={spans}
      />,
    )
    // Total: 300 + 700 = 1000ms = 1.0s
    expect(html).toContain('1.0s')
  })

  it('each auto-linker member span is present as a data-testid step-timeline-row inside the details', () => {
    // renderToStaticMarkup includes <details> content in the HTML (just not visible
    // by default in the browser). Verify each member row is present.
    const spans: StepSpan[] = [
      makeSpan({ stepName: 'auto-linker-direction', taskId: null, durationMs: 300, workflowInstanceId: 'wf-al-1' }),
      makeSpan({ stepName: 'auto-linker-direction', taskId: null, durationMs: 400, workflowInstanceId: 'wf-al-2' }),
    ]
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={spans}
      />,
    )
    const rowCount = (html.match(/data-testid="step-timeline-row"/g) ?? []).length
    expect(rowCount).toBe(2)
  })

  it('non-auto-linker proposal spans are not inside a details/summary collapse', () => {
    const spans: StepSpan[] = [
      makeSpan({ stepName: 'generate-slices', taskId: null, durationMs: 500 }),
      makeSpan({ stepName: 'action-quality-reprompt', taskId: null, durationMs: 200 }),
    ]
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={spans}
      />,
    )
    // No details element when there are no auto-linker spans
    expect(html).not.toContain('<details')
    // Both step names appear as normal rows
    expect(html).toContain('generate-slices')
    expect(html).toContain('action-quality-reprompt')
  })

  it('auto-linker activeStepName highlight lands on the correct span row inside details', () => {
    const spans: StepSpan[] = [
      makeSpan({ stepName: 'generate-slices', taskId: null, durationMs: 500 }),
      makeSpan({ stepName: 'auto-linker-direction', taskId: null, durationMs: 300, workflowInstanceId: 'wf-al-1' }),
    ]
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={spans}
        activeStepName="auto-linker-direction"
      />,
    )
    expect(html).toContain('data-active="true"')
    expect(html).toContain('ring-warn')
  })
})

// ── Proposal mode: child task group expanded by default ───────────────────────

describe('TaskDetailDrawer – child task group expanded by default', () => {
  const proposalId = 'prop-x'
  const taskAId = 'mars-22427f4d'

  it('child task spine steps are directly rendered (not inside a collapsed container)', () => {
    const spans: StepSpan[] = [
      makeSpan({ stepName: 'setup-worktree', taskId: taskAId, workflowInstanceId: 'wf-a' }),
      makeSpan({ stepName: 'run-claude-code', taskId: taskAId, workflowInstanceId: 'wf-a' }),
      makeSpan({ stepName: 'verify', taskId: taskAId, workflowInstanceId: 'wf-a' }),
      makeSpan({ stepName: 'merge', taskId: taskAId, workflowInstanceId: 'wf-a' }),
    ]
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[makeTask({ id: taskAId, cluster: 'Done', parentProposalId: proposalId })]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={spans}
      />,
    )
    // All 4 spine steps appear as individual rows
    const rowCount = (html.match(/data-testid="step-timeline-row"/g) ?? []).length
    expect(rowCount).toBe(4)
    // And they're not behind a collapsed details element (no <details> for these)
    expect(html).not.toContain('<details')
  })

  it('activeStepName highlight works for child task spans', () => {
    const spans: StepSpan[] = [
      makeSpan({ stepName: 'setup-worktree', taskId: taskAId, workflowInstanceId: 'wf-a' }),
      makeSpan({ stepName: 'run-claude-code', taskId: taskAId, workflowInstanceId: 'wf-a', outcome: 'running', endedAt: null, durationMs: null }),
    ]
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[makeTask({ id: taskAId, cluster: 'In progress', parentProposalId: proposalId })]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={spans}
        activeStepName="run-claude-code"
      />,
    )
    expect(html).toContain('data-active="true"')
    const activeMatches = (html.match(/data-active="true"/g) ?? []).length
    expect(activeMatches).toBe(1)
  })
})

// ── Proposal mode: fetch uses originId (structural check) ────────────────────

describe('TaskDetailDrawer – proposal fetch uses originId (structural check)', () => {
  it('proposal-mode drawer renders with full arc spans from multiple tasks', () => {
    // The fetch (in production) uses originId for proposal subjects so all child
    // spans are returned. Here we pass them via stepSpans to verify rendering.
    const proposalId = 'prop-x'
    const taskAId = 'mars-aaaabbbb'
    const taskBId = 'mars-ccccdddd'
    const spans: StepSpan[] = [
      makeSpan({ stepName: 'generate-slices', taskId: null, originId: proposalId }),
      makeSpan({ stepName: 'setup-worktree', taskId: taskAId, originId: proposalId }),
      makeSpan({ stepName: 'run-claude-code', taskId: taskAId, originId: proposalId }),
      makeSpan({ stepName: 'setup-worktree', taskId: taskBId, originId: proposalId }),
      makeSpan({ stepName: 'run-claude-code', taskId: taskBId, originId: proposalId }),
    ]
    const html = render(
      <TaskDetailDrawer
        taskId={proposalId}
        onClose={() => {}}
        tasks={[
          makeTask({ id: taskAId, cluster: 'Done', parentProposalId: proposalId }),
          makeTask({ id: taskBId, cluster: 'Done', parentProposalId: proposalId }),
        ]}
        proposals={[makeProposal(proposalId)]}
        stepSpans={spans}
      />,
    )
    // All three groups present
    expect(html).toContain('data-testid="step-group-proposal"')
    expect(html).toContain(`data-testid="step-group-${taskAId}"`)
    expect(html).toContain(`data-testid="step-group-${taskBId}"`)
    // Total rows = 4 (generate-slices + 2 pairs of setup/code from each task)
    const rowCount = (html.match(/data-testid="step-timeline-row"/g) ?? []).length
    expect(rowCount).toBe(5)
  })
})

// ── Task-mode unaffected (regression guard) ───────────────────────────────────

describe('TaskDetailDrawer – task-mode unaffected by proposal grouping (slice-4 regression)', () => {
  it('task-mode stepSpans render via flat StepTimeline (no step-group sections)', () => {
    const spans: StepSpan[] = [
      { stepName: 'setup-worktree', phase: null, workflowInstanceId: 'wf-1', workerName: null, outcome: 'completed', startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:00:01.000Z', durationMs: 1000, taskId: 'task-1', originId: 'task-1' },
      { stepName: 'run-claude-code', phase: null, workflowInstanceId: 'wf-1', workerName: null, outcome: 'completed', startedAt: '2026-01-01T10:00:01.000Z', endedAt: '2026-01-01T10:00:10.000Z', durationMs: 9000, taskId: 'task-1', originId: 'task-1' },
    ]
    const html = render(
      <TaskDetailDrawer
        taskId="task-1"
        onClose={() => {}}
        tasks={[makeTask({ id: 'task-1', cluster: 'Done' })]}
        proposals={[]}
        stepSpans={spans}
      />,
    )
    // Task mode must use step-card-list (StepCardList), not the grouped proposal layout
    expect(html).toContain('data-testid="step-card-list"')
    expect(html).not.toContain('data-testid="step-group-proposal"')
    expect(html).not.toContain('step-group-task-1')
    const rowCount = (html.match(/data-testid="step-card"/g) ?? []).length
    expect(rowCount).toBe(2)
  })

  it('task-mode activeStepName still highlights the matching row', () => {
    const spans: StepSpan[] = [
      { stepName: 'setup-worktree', phase: null, workflowInstanceId: 'wf-1', workerName: null, outcome: 'completed', startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:00:01.000Z', durationMs: 1000, taskId: 'task-1', originId: 'task-1' },
      { stepName: 'run-claude-code', phase: null, workflowInstanceId: 'wf-1', workerName: null, outcome: 'running', startedAt: '2026-01-01T10:00:01.000Z', endedAt: null, durationMs: null, taskId: 'task-1', originId: 'task-1' },
    ]
    const html = render(
      <TaskDetailDrawer
        taskId="task-1"
        onClose={() => {}}
        tasks={[makeTask({ id: 'task-1', cluster: 'In progress' })]}
        proposals={[]}
        stepSpans={spans}
        activeStepName="run-claude-code"
      />,
    )
    expect(html).toContain('data-active="true"')
    const activeMatches = (html.match(/data-active="true"/g) ?? []).length
    expect(activeMatches).toBe(1)
  })
})
