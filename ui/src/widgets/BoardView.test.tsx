import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProgressTask } from '@/shared/schemas'
import { BoardView, buildArcsByCluster } from './BoardView'

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

const emptyByCluster = () => ({
  Queued: [] as ProgressTask[],
  'In progress': [] as ProgressTask[],
  Blocked: [] as ProgressTask[],
  Failed: [] as ProgressTask[],
  Done: [] as ProgressTask[],
})

describe('buildArcsByCluster', () => {
  it('shows an arc with a failed origin and a blocked dependent in the Blocked column', () => {
    // A blocked dependent waiting on a dependency should surface in Blocked, not
    // swallowed by the Failed column of the origin it is waiting behind.
    const failedOrigin = task({
      id: 'origin-1',
      cluster: 'Failed',
      status: 'failed',
      originId: 'origin-1',
    })
    const blockedDependent = task({
      id: 'dependent-1',
      cluster: 'Blocked',
      status: 'blocked',
      originId: 'origin-1',
    })

    const arcs = buildArcsByCluster([failedOrigin, blockedDependent], [])

    expect(arcs.Blocked).toHaveLength(1)
    expect(arcs.Failed).toHaveLength(0)
  })

  it('shows a recovery Arc once, using its current queued state rather than an older failure', () => {
    const failedOrigin = task({
      id: 'origin-1',
      cluster: 'Failed',
      status: 'failed',
      originId: 'origin-1',
      updatedAt: '2024-01-01T00:00:00Z',
    })
    const queuedRecovery = task({
      id: 'fix-1',
      cluster: 'Queued',
      status: 'queued',
      originId: 'origin-1',
      fixForTaskId: 'origin-1',
      kind: 'fix',
      updatedAt: '2024-01-02T00:00:00Z',
    })

    const arcs = buildArcsByCluster([failedOrigin, queuedRecovery], [])

    expect(arcs.Failed).toHaveLength(0)
    expect(arcs.Queued).toHaveLength(1)
    expect(arcs.Queued[0]).toMatchObject({ id: 'origin-1', cluster: 'Queued' })
    expect(arcs.Queued[0]?.tasks.map((t) => t.id)).toEqual(['origin-1', 'fix-1'])
  })

  it('shows an arc with a failed task and running recovery in the In progress column', () => {
    const failedOrigin = task({
      id: 'origin-1',
      cluster: 'Failed',
      status: 'failed',
      originId: 'origin-1',
    })
    const runningRecovery = task({
      id: 'recovery-1',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-1',
    })

    const arcs = buildArcsByCluster([failedOrigin, runningRecovery], [])

    expect(arcs['In progress']).toHaveLength(1)
    expect(arcs.Failed).toHaveLength(0)
  })

  it('shows an arc with only blocked work in the Blocked column', () => {
    const blocked = task({
      id: 'blocked-1',
      cluster: 'Blocked',
      status: 'blocked',
      originId: 'blocked-1',
    })

    const arcs = buildArcsByCluster([blocked], [])

    expect(arcs.Blocked).toHaveLength(1)
    expect(arcs.Failed).toHaveLength(0)
  })

  it('does not render an arc when all of its tasks are done', () => {
    const completedOrigin = task({
      id: 'done-1',
      cluster: 'Done',
      status: 'done',
      originId: 'done-1',
    })
    const completedDependent = task({
      id: 'done-2',
      cluster: 'Done',
      status: 'done',
      originId: 'done-1',
    })

    const arcs = buildArcsByCluster([completedOrigin, completedDependent], [])

    expect(Object.values(arcs).flat()).toEqual([])
  })

  it('keeps legacy tasks without origin ids as individual arcs', () => {
    const first = task({ id: 'legacy-1', cluster: 'Queued' })
    const second = task({ id: 'legacy-2', cluster: 'Queued' })

    const arcs = buildArcsByCluster([first, second], [])

    expect(arcs.Queued.map((arc) => arc.id)).toEqual(['legacy-1', 'legacy-2'])
  })

  // ── Regression: blocked tasks must appear in the Blocked column (mars-fe1a057f) ──

  it('places a standalone blocked task in the Blocked column', () => {
    // Simplest case: a single blocked task with no arc siblings.
    // It must appear in Blocked (badge count > 0), not vanish into another column.
    const blocked = task({
      id: 'standalone-blocked',
      cluster: 'Blocked',
      status: 'blocked',
      originId: 'standalone-blocked',
    })

    const arcs = buildArcsByCluster([blocked], [])

    expect(arcs.Blocked).toHaveLength(1)
    expect(arcs.Blocked[0]!.id).toBe('standalone-blocked')
    expect(arcs.Queued).toHaveLength(0)
    expect(arcs.Failed).toHaveLength(0)
  })

  it('groups two blocked tasks sharing an origin into one Blocked card', () => {
    // Mirrors the live symptom: mars-5ddbd0 and mars-e3f5ab45 both blocked,
    // same origin — should produce a SINGLE card in the Blocked column.
    const blockedA = task({
      id: 'blocked-a',
      cluster: 'Blocked',
      status: 'blocked',
      originId: 'origin-x',
    })
    const blockedB = task({
      id: 'blocked-b',
      cluster: 'Blocked',
      status: 'blocked',
      originId: 'origin-x',
    })
    const failedOrigin = task({
      id: 'origin-x',
      cluster: 'Failed',
      status: 'failed',
      originId: 'origin-x',
    })

    const arcs = buildArcsByCluster([failedOrigin, blockedA, blockedB], [])

    // One Blocked card for the arc (not two, not zero, not in Failed)
    expect(arcs.Blocked).toHaveLength(1)
    expect(arcs.Blocked[0]!.id).toBe('origin-x')
    expect(arcs.Failed).toHaveLength(0)
    const taskIds = arcs.Blocked[0]!.tasks.map((t) => t.id).sort()
    expect(taskIds).toEqual(['blocked-a', 'blocked-b', 'origin-x'])
  })

  it('renders two Blocked cards for two independent blocked arcs', () => {
    // Mirrors the live symptom with two distinct origins:
    //   arc-1: mars-ebcc5b92 (blocked, origin 38898433-...)
    //   arc-2: mars-5ddbd0 + mars-e3f5ab45 (blocked, origin mars-d733b012)
    const blocked1 = task({
      id: 'blocked-1',
      cluster: 'Blocked',
      status: 'blocked',
      originId: 'failed-origin-a',
    })
    const failedA = task({
      id: 'failed-origin-a',
      cluster: 'Failed',
      status: 'failed',
      originId: 'failed-origin-a',
    })
    const blocked2 = task({
      id: 'blocked-2',
      cluster: 'Blocked',
      status: 'blocked',
      originId: 'failed-origin-b',
    })
    const blocked3 = task({
      id: 'blocked-3',
      cluster: 'Blocked',
      status: 'blocked',
      originId: 'failed-origin-b',
    })
    const failedB = task({
      id: 'failed-origin-b',
      cluster: 'Failed',
      status: 'failed',
      originId: 'failed-origin-b',
    })

    const arcs = buildArcsByCluster([failedA, blocked1, failedB, blocked2, blocked3], [])

    expect(arcs.Blocked).toHaveLength(2)
    expect(arcs.Failed).toHaveLength(0)
    const arcIds = arcs.Blocked.map((a) => a.id).sort()
    expect(arcIds).toEqual(['failed-origin-a', 'failed-origin-b'])
  })
})

describe('buildArcsByCluster — active count and unified status', () => {
  it('sets activeCount = number of non-Done tasks in the arc', () => {
    const doneOrigin = task({
      id: 'origin',
      cluster: 'Done',
      status: 'done',
      originId: 'origin',
    })
    const active1 = task({ id: 'a1', cluster: 'In progress', status: 'running', originId: 'origin' })
    const active2 = task({ id: 'a2', cluster: 'Failed', status: 'failed', originId: 'origin' })

    const arcs = buildArcsByCluster([doneOrigin, active1, active2], [])
    const arc = arcs['In progress'][0]!

    expect(arc.activeCount).toBe(2)            // 2 non-Done tasks
    expect(arc.tasks.length).toBe(3)           // total including Done origin
  })

  it('sets activeCount = tasks.length when no Done members are present', () => {
    const t1 = task({ id: 'o1', cluster: 'Queued', originId: 'o1' })
    const t2 = task({ id: 'f1', cluster: 'Queued', originId: 'o1', fixForTaskId: 'o1' })

    const arcs = buildArcsByCluster([t1, t2], [])
    const arc = arcs.Queued[0]!

    expect(arc.activeCount).toBe(2)
    expect(arc.tasks.length).toBe(2)
  })

  it('places arc in In progress when any live task exists, even with more failed tasks — same as topology dom', () => {
    // This is the status-word divergence scenario from the bug report:
    // topology used dominant() → Failed; board used live-priority → In progress.
    // Both now use arcPlacementCluster() so they agree.
    const failed1 = task({ id: 'f1', cluster: 'Failed', status: 'failed', originId: 'o1' })
    const failed2 = task({ id: 'f2', cluster: 'Failed', status: 'failed', originId: 'o1' })
    const live = task({ id: 'r1', cluster: 'In progress', status: 'running', originId: 'o1', fixForTaskId: 'f1' })

    const arcs = buildArcsByCluster([failed1, failed2, live], [])
    // Board places the arc in In progress (live priority).
    expect(arcs['In progress']).toHaveLength(1)
    expect(arcs.Failed).toHaveLength(0)
    expect(arcs['In progress'][0]!.cluster).toBe('In progress')
    expect(arcs['In progress'][0]!.activeCount).toBe(3) // all 3 are non-Done
  })
})

describe('BoardView – Arc summaries', () => {
  it('shows "X of Y active" count when Done members are included in the arc', () => {
    // Arc with a done origin + active recovery — the count must say how many
    // are still live so the operator can see that not all 3 tasks need attention.
    const doneOrigin = task({
      id: 'origin-d',
      cluster: 'Done',
      status: 'done',
      originId: 'origin-d',
    })
    const active = task({
      id: 'active-r',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-d',
    })
    // Done tasks arrive in byCluster['Done']; active in their cluster bucket.
    const byCluster = { ...emptyByCluster(), Done: [doneOrigin], 'In progress': [active] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // 1 active of 2 total → "1 of 2 active"
    expect(html).toContain('1 of 2 active')
    // Must NOT say "2 tasks" (would hide that one is done)
    expect(html).not.toMatch(/\b2 tasks?\b/)
  })

  it('shows plain task count when no Done members are present', () => {
    const t1 = task({ id: 'a', cluster: 'Queued' })
    const t2 = task({ id: 'b', cluster: 'Queued', originId: 'a' })
    const byCluster = { ...emptyByCluster(), Queued: [t1, t2] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('2 tasks')
    expect(html).not.toContain('of')
  })

  it('renders a single collapsed Arc with its tasks revealed on expansion', () => {
    const origin = task({
      id: 'origin-1',
      cluster: 'Failed',
      status: 'failed',
      originId: 'origin-1',
    })
    const recovery = task({
      id: 'fix-1',
      cluster: 'Queued',
      status: 'queued',
      originId: 'origin-1',
      fixForTaskId: 'origin-1',
      kind: 'fix',
    })
    const byCluster = { ...emptyByCluster(), Failed: [origin], Queued: [recovery] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html.match(/data-arc-id="origin-1"/g)).toHaveLength(1)
    expect(html).toContain('data-arc-status="Queued"')
    expect(html).toContain('origin-1')
    expect(html).toContain('fix-1')
    expect(html).not.toMatch(/data-arc-id="origin-1"[^>]*\bopen(?:=|\s|>)/)
  })

  it('counts Arcs, not contained tasks, in the status tab', () => {
    const origin = task({
      id: 'origin-1',
      cluster: 'Queued',
      originId: 'origin-1',
    })
    const followUp = task({
      id: 'fix-1',
      cluster: 'Queued',
      originId: 'origin-1',
      fixForTaskId: 'origin-1',
      kind: 'fix',
    })
    const byCluster = { ...emptyByCluster(), Queued: [origin, followUp] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toMatch(/data-tab="Queued"[^>]*>Queued<span[^>]*>1<\/span>/)
  })
})

describe('BoardView – substep label on in-progress arcs', () => {
  it('renders the arc’s live substep ("merging") derived from its executing task', () => {
    const merging = task({
      id: 'origin-live',
      prompt: 'Ship the widget',
      cluster: 'In progress',
      status: 'merging',
      originId: 'origin-live',
    })
    const byCluster = { ...emptyByCluster(), 'In progress': [merging] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // The specific substep label appears (the column already says "In progress").
    expect(html).toContain('merging')
    expect(html).toContain('text-status-running')
  })

  it('maps status running to the "coding" substep', () => {
    const running = task({
      id: 'origin-run',
      prompt: 'Build the thing',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-run',
    })
    const byCluster = { ...emptyByCluster(), 'In progress': [running] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('coding')
  })

  it('does not render a substep line for a queued arc', () => {
    const queued = task({ id: 'q1', prompt: 'Later work', cluster: 'Queued' })
    const byCluster = { ...emptyByCluster(), Queued: [queued] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // No running-coloured substep chip on a non-live arc.
    expect(html).not.toContain('uppercase tracking-wide text-status-running')
  })
})

describe('BoardView – in-progress card animation', () => {
  it('applies the subtle live-breathe class to an in-progress arc', () => {
    const running = task({
      id: 'origin-run',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-run',
    })
    const byCluster = { ...emptyByCluster(), 'In progress': [running] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('mars-card-live')
  })

  it('does not apply the live-breathe class to a queued arc', () => {
    const queued = task({ id: 'q1', cluster: 'Queued' })
    const byCluster = { ...emptyByCluster(), Queued: [queued] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).not.toContain('mars-card-live')
  })
})

describe('BoardView – proposal filter on cluster columns', () => {
  it('shows only tasks from the selected proposal when a filter is active', () => {
    const t1 = task({ id: 'task-from-p1', cluster: 'Queued', parentProposalId: 'p1' })
    const t2 = task({ id: 'task-from-p2', cluster: 'Queued', parentProposalId: 'p2' })
    const byCluster = { ...emptyByCluster(), Queued: [t1, t2] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId="p1" />,
    )

    expect(html).toContain('task-from-p1')
    expect(html).not.toContain('task-from-p2')
  })

  it('shows all tasks when no proposal filter is active', () => {
    const t1 = task({ id: 'task-from-p1', cluster: 'Queued', parentProposalId: 'p1' })
    const t2 = task({ id: 'task-from-p2', cluster: 'Queued', parentProposalId: 'p2' })
    const byCluster = { ...emptyByCluster(), Queued: [t1, t2] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
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
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId="p1" />,
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
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId="p1" />,
    )

    expect(html).toContain('p1-task')
    expect(html).not.toContain('no-parent')
  })

  it('restores all tasks when the proposal filter is cleared (null)', () => {
    const t1 = task({ id: 'no-parent', cluster: 'Queued', parentProposalId: null })
    const t2 = task({ id: 'p1-task', cluster: 'Queued', parentProposalId: 'p1' })
    const byCluster = { ...emptyByCluster(), Queued: [t1, t2] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
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
        proposals={[]}
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
        proposals={[]}
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
        proposals={[]}
        error={null}
        selectedProposalId={null}
        searchMatchIds={null}
      />,
    )

    expect(html).toContain('task-a')
    expect(html).toContain('task-b')
  })
})

describe('BoardView – proposal-filter empty state', () => {
  it('shows "No active tasks for this proposal" when the proposal filter yields nothing', () => {
    // All tasks belong to proposal p2; filter is set to p1 → nothing matches.
    const t1 = task({ id: 'p2-task', cluster: 'Queued', parentProposalId: 'p2' })
    const byCluster = { ...emptyByCluster(), Queued: [t1] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId="p1" />,
    )

    expect(html).toContain('No active tasks for this proposal')
  })

  it('does not show the proposal empty-state when no proposal filter is active', () => {
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).not.toContain('No active tasks for this proposal')
  })

  it('renders a clear-filter button with the correct testid', () => {
    const t1 = task({ id: 'p2-task', cluster: 'Queued', parentProposalId: 'p2' })
    const byCluster = { ...emptyByCluster(), Queued: [t1] }

    const html = renderToStaticMarkup(
      <BoardView
        byCluster={byCluster}
        proposals={[]}
        error={null}
        selectedProposalId="p1"
        onClearProposalFilter={() => {}}
      />,
    )

    expect(html).toContain('data-testid="clear-proposal-filter"')
  })

  it('does not show the proposal empty-state when the search filter is also active (search takes precedence)', () => {
    // Search is active (searchMatchIds is non-null) so the search zero-state should show, not the proposal one.
    const t1 = task({ id: 'p1-task', cluster: 'Queued', parentProposalId: 'p1' })
    const byCluster = { ...emptyByCluster(), Queued: [t1] }

    const html = renderToStaticMarkup(
      <BoardView
        byCluster={byCluster}
        proposals={[]}
        error={null}
        selectedProposalId="p1"
        searchMatchIds={new Set()}
        searchQuery="nomatch"
      />,
    )

    // The search zero-state is shown; the proposal empty-state is not.
    expect(html).toContain('data-testid="search-zero-state"')
    expect(html).not.toContain('No active tasks for this proposal')
  })
})

describe('BoardView – mobile responsive tab strip (single-column below breakpoint)', () => {
  it('renders a tab strip with a button for each cluster status', () => {
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('data-testid="board-tab-strip"')
    expect(html).toContain('data-tab="Queued"')
    expect(html).toContain('data-tab="In progress"')
    expect(html).toContain('data-tab="Blocked"')
    expect(html).toContain('data-tab="Failed"')
  })

  it('never renders a Proposals tab (proposals are not part of the board)', () => {
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).not.toContain('data-tab="Proposals"')
    expect(html).not.toContain('data-cluster="Proposals"')
  })

  it('defaults the active tab to Failed when failed tasks are present', () => {
    const t = task({ id: 'f1', cluster: 'Failed', status: 'failed' })
    const byCluster = { ...emptyByCluster(), Failed: [t] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // The Failed tab button carries aria-selected=true; Queued does not
    expect(html).toMatch(/data-tab="Failed"[^>]*aria-selected="true"/)
    expect(html).toMatch(/data-tab="Queued"[^>]*aria-selected="false"/)
  })

  it('defaults to In progress when no failures but in-progress tasks exist', () => {
    const t = task({ id: 'r1', cluster: 'In progress', status: 'running' })
    const byCluster = { ...emptyByCluster(), 'In progress': [t] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toMatch(/data-tab="In progress"[^>]*aria-selected="true"/)
    expect(html).toMatch(/data-tab="Failed"[^>]*aria-selected="false"/)
  })

  it('defaults to Queued when board is empty (no failed, no in-progress)', () => {
    const html = renderToStaticMarkup(
      <BoardView byCluster={emptyByCluster()} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toMatch(/data-tab="Queued"[^>]*aria-selected="true"/)
  })

  it('marks non-active cluster column wrappers as hidden on mobile (class starts with "hidden")', () => {
    const t = task({ id: 'f1', cluster: 'Failed', status: 'failed' })
    const byCluster = { ...emptyByCluster(), Failed: [t] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
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
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // Count "1" should appear near the Failed tab
    expect(html).toContain('>1<')
  })
})

describe('BoardView – column lane styling (no card-in-card nesting)', () => {
  it('board columns are styled as borderless lanes, not bordered cards', () => {
    const t1 = task({ id: 'task-q', cluster: 'Queued' })
    const byCluster = { ...emptyByCluster(), Queued: [t1] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // Column lane wrappers must not add a card-level border around already-carded TaskCards.
    // The combination "border border-border bg-secondary" is the column card anti-pattern.
    expect(html).not.toContain('border border-border bg-secondary')
  })

  it('column header carries an underline to preserve visual separation without full card chrome', () => {
    const t1 = task({ id: 'task-q', cluster: 'Queued' })
    const byCluster = { ...emptyByCluster(), Queued: [t1] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // The column <header> element (not the tab strip) must carry a border-b underline
    // so the lane heading is visually separated from cards without a full card border.
    expect(html).toMatch(/<header[^>]*class="[^"]*\bborder-b\b/)
  })
})

// ---------------------------------------------------------------------------
// Arc lifecycle: force-purge compensation and orphaned-origin states
// ---------------------------------------------------------------------------

describe('buildArcsByCluster — arc lifecycle states', () => {
  it('sets hasOrphanedOrigin=true when the recovery task has no origin in the board', () => {
    // Origin was force-purged (deleted from DB); only the recovery remains.
    const recovery = task({
      id: 'fix-orphan',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-deleted',  // references a deleted origin
      fixForTaskId: 'origin-deleted',
      kind: 'fix',
    })

    const arcs = buildArcsByCluster([recovery], [])

    expect(arcs['In progress']).toHaveLength(1)
    expect(arcs['In progress'][0]?.hasOrphanedOrigin).toBe(true)
  })

  it('sets hasOrphanedOrigin=false when origin is present alongside recovery', () => {
    const origin = task({ id: 'origin-1', cluster: 'Failed', status: 'failed', originId: 'origin-1' })
    const recovery = task({
      id: 'fix-1',
      cluster: 'Queued',
      status: 'queued',
      originId: 'origin-1',
      fixForTaskId: 'origin-1',
      kind: 'fix',
    })

    const arcs = buildArcsByCluster([origin, recovery], [])
    const allArcs = [...arcs.Queued, ...arcs.Failed, ...arcs['In progress'], ...arcs.Blocked]

    expect(allArcs).toHaveLength(1)
    expect(allArcs[0]?.hasOrphanedOrigin).toBe(false)
  })

  it('uses "Abandoned arc <id>" as title for orphaned arcs, not the recovery prompt', () => {
    const recovery = task({
      id: 'fix-orphan',
      prompt: 'Fix failing step: verify — something technical',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-deleted',
      kind: 'fix',
    })

    const arcs = buildArcsByCluster([recovery], [])
    const arc = arcs['In progress'][0]!

    expect(arc.title).toBe('Abandoned arc origin-deleted')
    expect(arc.title).not.toContain('Fix failing step')
  })

  it('propagates compensatesArcId from a compensation task to the arc', () => {
    const compensationTask = task({
      id: 'comp-1',
      cluster: 'Queued',
      status: 'queued',
      originId: 'comp-1',
      compensatesArcId: 'origin-purged',
    })

    const arcs = buildArcsByCluster([compensationTask], [])

    expect(arcs.Queued).toHaveLength(1)
    expect(arcs.Queued[0]?.compensatesArcId).toBe('origin-purged')
  })
})

describe('BoardView — arc lifecycle rendering', () => {
  it('renders orphaned-origin arc with data-arc-state="orphaned-origin"', () => {
    // Only the recovery task is on the board (origin force-purged).
    const recovery = task({
      id: 'fix-orphan',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-deleted',
      kind: 'fix',
    })
    const byCluster = { ...emptyByCluster(), 'In progress': [recovery] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('data-arc-state="orphaned-origin"')
    expect(html).toContain('Abandoned arc origin-deleted')
    expect(html).toContain('origin force-purged')
    // Must NOT use line-through (recovery is active, not abandoned).
    expect(html).not.toContain('line-through')
  })

  it('renders compensation arc with data-arc-state="cleanup-required" and badge', () => {
    const compensation = task({
      id: 'comp-1',
      cluster: 'Queued',
      status: 'queued',
      originId: 'comp-1',
      compensatesArcId: 'origin-purged',
    })
    const byCluster = { ...emptyByCluster(), Queued: [compensation] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('data-arc-state="cleanup-required"')
    expect(html).toContain('↩ compensates arc origin-purged')
    expect(html).toContain('data-compensates-arc="origin-purged"')
  })

  it('renders normal active arc with data-arc-state="active"', () => {
    const origin = task({ id: 'origin-1', cluster: 'Queued', status: 'queued', originId: 'origin-1' })
    const byCluster = { ...emptyByCluster(), Queued: [origin] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('data-arc-state="active"')
    expect(html).not.toContain('data-arc-state="orphaned-origin"')
    expect(html).not.toContain('data-arc-state="cleanup-required"')
  })
})

// ---------------------------------------------------------------------------
// Regression: done origin must not produce "Abandoned arc" (mars-bf869037)
// ---------------------------------------------------------------------------

describe('buildArcsByCluster — done origin regression', () => {
  it('sets hasOrphanedOrigin=false when the origin is Done (completed, not purged)', () => {
    // Arc: done origin + running sibling + blocked sibling — all sharing the same originId.
    // This mirrors the mars-bf869037 scenario exactly.
    const doneOrigin = task({
      id: 'origin-done',
      prompt: 'Implement the feature',
      cluster: 'Done',
      status: 'done',
      originId: 'origin-done',
    })
    const runningSlice = task({
      id: 'slice-running',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-done',
    })
    const blockedSlice = task({
      id: 'slice-blocked',
      cluster: 'Blocked',
      status: 'blocked',
      originId: 'origin-done',
    })

    const arcs = buildArcsByCluster([doneOrigin, runningSlice, blockedSlice], [])

    // Live work outranks Blocked so an executing sibling remains visible.
    expect(arcs['In progress']).toHaveLength(1)
    const arc = arcs['In progress'][0]!
    expect(arc.id).toBe('origin-done')
    expect(arc.hasOrphanedOrigin).toBe(false)
    expect(arc.title).toBe('Implement the feature')
    expect(arc.title).not.toMatch(/Abandoned arc/)
  })

  it('places the arc in Blocked column when that is the highest-attention active cluster', () => {
    const doneOrigin = task({
      id: 'O',
      prompt: 'Ship widget',
      cluster: 'Done',
      status: 'done',
      originId: 'O',
    })
    const blockedSlice = task({
      id: 'S1',
      cluster: 'Blocked',
      status: 'blocked',
      originId: 'O',
    })

    const arcs = buildArcsByCluster([doneOrigin, blockedSlice], [])

    expect(arcs.Blocked).toHaveLength(1)
    expect(arcs['In progress']).toHaveLength(0)
    expect(arcs.Failed).toHaveLength(0)
    expect(arcs.Blocked[0]!.hasOrphanedOrigin).toBe(false)
  })

  it('skips an arc whose tasks are all Done — not rendered in any column', () => {
    const doneOrigin = task({
      id: 'origin-all-done',
      cluster: 'Done',
      status: 'done',
      originId: 'origin-all-done',
    })
    const doneSlice = task({
      id: 'slice-done',
      cluster: 'Done',
      status: 'done',
      originId: 'origin-all-done',
    })

    const arcs = buildArcsByCluster([doneOrigin, doneSlice], [])

    const allArcs = [
      ...arcs.Blocked,
      ...arcs['In progress'],
      ...arcs.Queued,
      ...arcs.Failed,
    ]
    expect(allArcs).toHaveLength(0)
  })

  it('still sets hasOrphanedOrigin=true when origin is genuinely absent (force-purged)', () => {
    // No origin row in the input — only the recovery task. This is the
    // legitimate "Abandoned arc" case and must keep working.
    const recovery = task({
      id: 'fix-orphan',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-deleted',
      fixForTaskId: 'origin-deleted',
      kind: 'fix',
    })

    const arcs = buildArcsByCluster([recovery], [])

    expect(arcs['In progress']).toHaveLength(1)
    expect(arcs['In progress'][0]!.hasOrphanedOrigin).toBe(true)
    expect(arcs['In progress'][0]!.title).toBe('Abandoned arc origin-deleted')
  })
})

// ---------------------------------------------------------------------------
// parentProposalId grouping: tasks share parentProposalId, different originIds
// ---------------------------------------------------------------------------

describe('buildArcsByCluster — parentProposalId grouping', () => {
  it('groups tasks with the same parentProposalId into one arc keyed by the proposal', () => {
    const taskA = task({
      id: 'task-a',
      cluster: 'Queued',
      status: 'queued',
      originId: 'origin-a',
      parentProposalId: 'prop-1',
    })
    const taskB = task({
      id: 'task-b',
      cluster: 'Queued',
      status: 'queued',
      originId: 'origin-b',
      parentProposalId: 'prop-1',
    })
    const proposal = { id: 'prop-1', title: 'My Big Feature', source: 'human' as const, status: 'draft' }

    const arcs = buildArcsByCluster([taskA, taskB], [proposal])

    expect(arcs.Queued).toHaveLength(1)
    expect(arcs.Queued[0]!.id).toBe('prop-1')
    expect(arcs.Queued[0]!.title).toBe('My Big Feature')
    expect(arcs.Queued[0]!.hasOrphanedOrigin).toBe(false)
    expect(arcs.Queued[0]!.tasks.map((t) => t.id).sort()).toEqual(['task-a', 'task-b'])
  })

  it('uses the proposal title (not any task prompt) for parentProposalId-keyed arcs', () => {
    const t = task({
      id: 'task-1',
      prompt: 'Do the work',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-1',
      parentProposalId: 'prop-xyz',
    })
    const proposal = { id: 'prop-xyz', title: 'Feature: new pipeline', source: 'human' as const, status: 'draft' }

    const arcs = buildArcsByCluster([t], [proposal])
    const arc = arcs['In progress'][0]!

    expect(arc.title).toBe('Feature: new pipeline')
    expect(arc.title).not.toContain('Do the work')
  })

  it('keeps tasks with different parentProposalIds in separate arcs', () => {
    const taskA = task({
      id: 'task-a',
      cluster: 'Queued',
      parentProposalId: 'prop-1',
    })
    const taskB = task({
      id: 'task-b',
      cluster: 'Queued',
      parentProposalId: 'prop-2',
    })
    const p1 = { id: 'prop-1', title: 'Proposal One', source: 'human' as const, status: 'draft' }
    const p2 = { id: 'prop-2', title: 'Proposal Two', source: 'human' as const, status: 'draft' }

    const arcs = buildArcsByCluster([taskA, taskB], [p1, p2])

    expect(arcs.Queued).toHaveLength(2)
    const ids = arcs.Queued.map((a) => a.id).sort()
    expect(ids).toEqual(['prop-1', 'prop-2'])
  })
})

// ---------------------------------------------------------------------------
// Proposal-rooted arcs: origin_id holds a proposal id, not a task id
// ---------------------------------------------------------------------------

describe('buildArcsByCluster — proposal-rooted arcs', () => {
  it('sets hasOrphanedOrigin=false when the arc id resolves to a proposal', () => {
    // Arc produced by `mars proposal slice`: origin_id = proposal id.
    const slice = task({
      id: 'slice-1',
      cluster: 'In progress',
      status: 'running',
      originId: 'proposal-abc',
    })
    const proposal = { id: 'proposal-abc', title: 'Durable merge queue', source: 'human' as const, status: 'draft' }

    const arcs = buildArcsByCluster([slice], [proposal])

    expect(arcs['In progress']).toHaveLength(1)
    expect(arcs['In progress'][0]?.hasOrphanedOrigin).toBe(false)
  })

  it('uses the proposal title (not "Abandoned arc") when the arc id is a known proposal', () => {
    const slice = task({
      id: 'slice-1',
      cluster: 'Queued',
      status: 'queued',
      originId: 'proposal-abc',
    })
    const proposal = { id: 'proposal-abc', title: 'Durable merge queue', source: 'human' as const, status: 'draft' }

    const arcs = buildArcsByCluster([slice], [proposal])
    const arc = arcs.Queued[0]!

    expect(arc.title).toBe('Durable merge queue')
    expect(arc.title).not.toMatch(/Abandoned arc/)
  })

  it('still sets hasOrphanedOrigin=true when the arc id is in neither tasks nor proposals', () => {
    const recovery = task({
      id: 'fix-orphan',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-force-purged',
      fixForTaskId: 'origin-force-purged',
      kind: 'fix',
    })
    // Proposals list does not contain 'origin-force-purged'
    const proposal = { id: 'unrelated-proposal', title: 'Something else', source: 'human' as const, status: 'draft' }

    const arcs = buildArcsByCluster([recovery], [proposal])

    expect(arcs['In progress'][0]?.hasOrphanedOrigin).toBe(true)
    expect(arcs['In progress'][0]?.title).toBe('Abandoned arc origin-force-purged')
  })
})

describe('BoardView — proposal-rooted arc rendering', () => {
  it('renders a proposal-rooted arc with proposal title and no "origin force-purged" line', () => {
    const slice = task({
      id: 'slice-1',
      cluster: 'In progress',
      status: 'running',
      originId: 'proposal-abc',
    })
    const byCluster = { ...emptyByCluster(), 'In progress': [slice] }
    const proposals = [{ id: 'proposal-abc', title: 'Durable merge queue', source: 'human' as const, status: 'draft' }]

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={proposals} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('Durable merge queue')
    expect(html).not.toContain('Abandoned arc')
    expect(html).not.toContain('origin force-purged')
    expect(html).not.toContain('data-arc-state="orphaned-origin"')
  })

  it('renders an arc whose id is in neither namespace with "Abandoned arc" treatment', () => {
    const recovery = task({
      id: 'fix-orphan',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-force-purged',
      fixForTaskId: 'origin-force-purged',
      kind: 'fix',
    })
    const byCluster = { ...emptyByCluster(), 'In progress': [recovery] }
    // Proposals list does not include 'origin-force-purged'
    const proposals = [{ id: 'unrelated', title: 'Unrelated proposal', source: 'human' as const, status: 'draft' }]

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={proposals} error={null} selectedProposalId={null} />,
    )

    expect(html).toContain('Abandoned arc origin-force-purged')
    expect(html).toContain('origin force-purged')
    expect(html).toContain('data-arc-state="orphaned-origin"')
  })
})

describe('BoardView — done origin regression rendering', () => {
  it('renders arc in In progress with no "origin force-purged" when origin is Done', () => {
    const doneOrigin = task({
      id: 'origin-done',
      prompt: 'Ship the widget feature',
      cluster: 'Done',
      status: 'done',
      originId: 'origin-done',
    })
    const runningSlice = task({
      id: 'slice-running',
      cluster: 'In progress',
      status: 'running',
      originId: 'origin-done',
    })
    const blockedSlice = task({
      id: 'slice-blocked',
      cluster: 'Blocked',
      status: 'blocked',
      originId: 'origin-done',
    })
    // Done tasks arrive in byCluster['Done']; active siblings in their own buckets
    const byCluster = {
      ...emptyByCluster(),
      Done: [doneOrigin],
      'In progress': [runningSlice],
      Blocked: [blockedSlice],
    }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // Live work outranks a blocked sibling.
    expect(html).toContain('data-arc-status="In progress"')
    // hasOrphanedOrigin=false → no "origin force-purged" subtitle
    expect(html).not.toContain('origin force-purged')
    // Title comes from origin prompt, not "Abandoned arc …"
    expect(html).toContain('Ship the widget feature')
    expect(html).not.toContain('Abandoned arc origin-done')
    // arc-state is active (not orphaned)
    expect(html).not.toContain('data-arc-state="orphaned-origin"')
    // No line-through (recovery/sibling is active)
    expect(html).not.toContain('line-through')
  })

  it('does not render any column card for an all-Done arc', () => {
    const doneOrigin = task({
      id: 'fully-done',
      prompt: 'Already completed work',
      cluster: 'Done',
      status: 'done',
      originId: 'fully-done',
    })
    const byCluster = { ...emptyByCluster(), Done: [doneOrigin] }

    const html = renderToStaticMarkup(
      <BoardView byCluster={byCluster} proposals={[]} error={null} selectedProposalId={null} />,
    )

    // Arc must not appear anywhere on the board
    expect(html).not.toContain('data-arc-id="fully-done"')
    // No arc cards at all
    expect(html).not.toContain('Already completed work')
  })
})
