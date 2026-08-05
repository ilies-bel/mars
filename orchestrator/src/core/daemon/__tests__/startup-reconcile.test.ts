/**
 * Tests for runStartupReconcile — the extracted startup-reconcile pass.
 *
 * Core regression: a blocked task with zero live blocker edges (orphaned by a
 * dropTask / purge that deleted the edge but left the dependent blocked) must
 * be re-queued by the reconcile.  A task with a live (non-'done') blocker must
 * stay blocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  addBlockers: typeof import('../../queue').addBlockers
  updateTask: typeof import('../../queue').updateTask
}

interface ReconcileModule {
  runStartupReconcile: typeof import('../startup-reconcile').runStartupReconcile
}

interface ProposalsModule {
  createProposal: typeof import('../../proposals').createProposal
  getProposal: typeof import('../../proposals').getProposal
  setProposalField: typeof import('../../proposals').setProposalField
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-startup-reconcile-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; reconcile: ReconcileModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const reconcile = (await import('../startup-reconcile')) as unknown as ReconcileModule
  return { q, reconcile }
}

/** Minimal deps for standalone reconcile in tests — no trace store, no proposal slicing. */
const makeDeps = () => ({
  log: (_line: string): void => {
    // suppress verbose logs in test output
  },
  bus: new EventEmitter(),
  traceStore: null,
  handleProposalSlice: null,
})

describe('runStartupReconcile — stranded slicing proposals', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns a proposal left slicing by a prior daemon to prd-ready', async () => {
    const { reconcile } = await loadModules(repo)
    const proposals = (await import('../../proposals')) as unknown as ProposalsModule
    const proposal = await proposals.createProposal('Interrupted slice', { source: 'human' })
    await proposals.setProposalField(proposal.id, 'status', 'slicing')

    const summary = await reconcile.runStartupReconcile(makeDeps())

    expect((await proposals.getProposal(proposal.id))?.status).toBe('prd-ready')
    expect(summary.strandedSlicingReverted).toBe(1)
  })

  it('leaves a proposal alone while this daemon is slicing it', async () => {
    const { reconcile } = await loadModules(repo)
    const proposals = (await import('../../proposals')) as unknown as ProposalsModule
    const proposal = await proposals.createProposal('Active slice', { source: 'human' })
    await proposals.setProposalField(proposal.id, 'status', 'slicing')

    const summary = await reconcile.runStartupReconcile({
      ...makeDeps(),
      isProposalSliceInFlight: (proposalId: string) => proposalId === proposal.id,
    })

    expect((await proposals.getProposal(proposal.id))?.status).toBe('slicing')
    expect(summary.strandedSlicingReverted).toBe(0)
  })
})

describe('runStartupReconcile — orphaned-blocked scan', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('re-queues a blocked task that has zero live blocker edges (orphan)', async () => {
    const { q, reconcile } = await loadModules(repo)

    // Create a task and force it into 'blocked' with no blocker edges.
    // This is the "orphaned-blocked" state: the edge was deleted (e.g. by
    // dropTask/purge) but the dependent was never promoted back to queued.
    const task = await q.enqueueTask('orphaned task', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [task.id],
    })

    const summary = await reconcile.runStartupReconcile(makeDeps())

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')
    expect(summary.orphanedBlockedRequeued).toBe(1)
  })

  it('drops a failed Chore when its origin had already succeeded', async () => {
    const { q, reconcile } = await loadModules(repo)
    const origin = await q.enqueueTask('successful origin', undefined, { skipTriage: true })
    const chore = await q.enqueueTask('stale Chore', undefined, { skipTriage: true })
    await q.updateTask(origin.id, { status: 'done' })
    await q.updateTask(chore.id, { status: 'failed' })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET kind = 'fix', fix_for_task_id = ?, origin_id = ? WHERE id = ?`,
      args: [origin.id, origin.id, chore.id],
    })

    const summary = await reconcile.runStartupReconcile(makeDeps())

    expect((await q.getTask(origin.id))?.status).toBe('done')
    expect(await q.getTask(chore.id)).toMatchObject({
      status: 'dropped',
      dropReason: 'origin-succeeded',
    })
    expect(summary.terminalOriginChoresDropped).toBe(1)
  })

  it('leaves a blocked task blocked when it still has a live (non-done) blocker', async () => {
    const { q, reconcile } = await loadModules(repo)

    // Blocker is queued (not done) — the dependent must stay blocked.
    const blocker = await q.enqueueTask('live blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('dependent task', undefined, { skipTriage: true })

    await q.addBlockers(dependent.id, [blocker.id])
    // Force the dependent to blocked (simulating how blocked tasks are normally created)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [dependent.id],
    })

    const summary = await reconcile.runStartupReconcile(makeDeps())

    const updated = await q.getTask(dependent.id)
    expect(updated?.status).toBe('blocked')
    expect(summary.orphanedBlockedRequeued).toBe(0)
  })

  // Boot-time heal for rows stranded before the drop-release fix landed. A
  // `dropped` blocker is terminal and can never reach `done`, so the dependent
  // would otherwise sit in `blocked` forever with no action-queue row to
  // resolve. Live case: mars-95f2318e behind fix-3a03bbf2 (arc-rescued).
  it('re-queues a blocked task whose only blocker is dropped', async () => {
    const { q, reconcile } = await loadModules(repo)

    const blocker = await q.enqueueTask('dropped blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('stranded dependent', undefined, { skipTriage: true })
    await q.addBlockers(dependent.id, [blocker.id])
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'dropped' WHERE id = ?`,
      args: [blocker.id],
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [dependent.id],
    })

    const summary = await reconcile.runStartupReconcile(makeDeps())

    expect((await q.getTask(dependent.id))?.status).toBe('queued')
    expect(summary.orphanedBlockedRequeued).toBe(1)
  })

  // The `failed` half of the contract is unchanged: a dependent behind an
  // ordinary failed blocker keeps waiting for explicit operator resolution.
  it('leaves a blocked task blocked when its only blocker is failed', async () => {
    const { q, reconcile } = await loadModules(repo)

    const blocker = await q.enqueueTask('failed blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('waiting dependent', undefined, { skipTriage: true })
    await q.addBlockers(dependent.id, [blocker.id])
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [blocker.id],
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [dependent.id],
    })

    const summary = await reconcile.runStartupReconcile(makeDeps())

    expect((await q.getTask(dependent.id))?.status).toBe('blocked')
    expect(summary.orphanedBlockedRequeued).toBe(0)
  })

  it('is idempotent — second pass is a no-op when the queue is already consistent', async () => {
    const { q, reconcile } = await loadModules(repo)

    // Create an orphaned-blocked task.
    const task = await q.enqueueTask('idempotent task', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [task.id],
    })

    // First pass re-queues the orphaned task.
    const first = await reconcile.runStartupReconcile(makeDeps())
    expect(first.orphanedBlockedRequeued).toBe(1)

    const afterFirst = await q.getTask(task.id)
    expect(afterFirst?.status).toBe('queued')

    // Second pass sees no blocked tasks — nothing to do.
    const second = await reconcile.runStartupReconcile(makeDeps())
    expect(second.orphanedBlockedRequeued).toBe(0)
    expect(second.blockerDriftRepaired).toBe(0)

    // Task stays queued.
    const afterSecond = await q.getTask(task.id)
    expect(afterSecond?.status).toBe('queued')
  })

  it('handles a mix of orphaned and legitimately-blocked tasks correctly', async () => {
    const { q, reconcile } = await loadModules(repo)

    // Orphaned: blocked with no edges → should be re-queued.
    const orphan = await q.enqueueTask('orphan', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [orphan.id],
    })

    // Legitimately blocked: has an incomplete blocker → must stay blocked.
    const blocker = await q.enqueueTask('active blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('legitimate dependent', undefined, {
      skipTriage: true,
    })
    await q.addBlockers(dependent.id, [blocker.id])
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [dependent.id],
    })

    const summary = await reconcile.runStartupReconcile(makeDeps())

    const updatedOrphan = await q.getTask(orphan.id)
    const updatedDependent = await q.getTask(dependent.id)

    expect(updatedOrphan?.status).toBe('queued')
    expect(updatedDependent?.status).toBe('blocked')
    // Only the orphan was re-queued.
    expect(summary.orphanedBlockedRequeued).toBe(1)
  })

  it('re-queues an orphan even after its edge was explicitly deleted', async () => {
    const { q, reconcile } = await loadModules(repo)

    // Simulate the exact "purge deletes edge, dependent stays blocked" bug:
    // create a proper blocker → dependent setup, then delete the edge.
    const blocker = await q.enqueueTask('purged blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('stranded dependent', undefined, { skipTriage: true })

    await q.addBlockers(dependent.id, [blocker.id])
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [dependent.id],
    })

    // Delete the blocker edge (as dropTask / purge would do).
    await q.resolveQueueClient().execute({
      sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
      args: [dependent.id, blocker.id],
    })

    // Dependent is now blocked with zero edges → orphaned.
    const summary = await reconcile.runStartupReconcile(makeDeps())

    const updated = await q.getTask(dependent.id)
    expect(updated?.status).toBe('queued')
    expect(summary.orphanedBlockedRequeued).toBe(1)
  })
})

describe('runStartupReconcile — stalled proposal slicing', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('skips a ready proposal whose previous slice attempt failed', async () => {
    const { q, reconcile } = await loadModules(repo)
    const proposals = (await import('../../proposals')) as unknown as ProposalsModule
    const proposal = await proposals.createProposal('Failed slice', { source: 'human' })
    await q.resolveQueueClient().execute({
      sql: `UPDATE proposals
            SET status = 'prd-ready', last_slice_error = 'invalid slice references', last_slice_failed_at = ?
            WHERE id = ?`,
      args: [Date.now(), proposal.id],
    })
    const slice = vi.fn(async () => ({}))
    const logs: string[] = []

    const summary = await reconcile.runStartupReconcile({
      ...makeDeps(),
      log: (line) => logs.push(line),
      handleProposalSlice: slice,
    })

    expect(slice).not.toHaveBeenCalled()
    expect(summary.stalledProposalsSliced).toBe(0)
    expect(logs.join('\n')).toContain('invalid slice references')
  })

  it('dispatches a ready proposal that has no recorded slice failure', async () => {
    const { reconcile } = await loadModules(repo)
    const proposals = (await import('../../proposals')) as unknown as ProposalsModule
    const proposal = await proposals.createProposal('Ready slice', { source: 'human' })
    const client = (await import('../../queue')).resolveQueueClient()
    await client.execute({
      sql: `UPDATE proposals SET status = 'prd-ready' WHERE id = ?`,
      args: [proposal.id],
    })
    const slice = vi.fn(async () => ({}))

    const summary = await reconcile.runStartupReconcile({ ...makeDeps(), handleProposalSlice: slice })

    expect(slice).toHaveBeenCalledWith(proposal.id)
    expect(summary.stalledProposalsSliced).toBe(1)
  })
})

describe('runStartupReconcile — retired planning gate', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('closes legacy gate rows and releases legacy draft slices exactly once', async () => {
    const { q, reconcile } = await loadModules(repo)
    const proposals = (await import('../../proposals')) as unknown as ProposalsModule
    const proposal = await proposals.createProposal('Legacy slice', { source: 'human' })
    const queued = await q.enqueueTask('independent legacy slice', undefined, {
      parentProposalId: proposal.id,
      spec: { files: [], verifyCmd: null, doneCriteria: [], mergeMode: 'auto', sliceKind: 'coder' },
    })
    const blocker = await q.enqueueTask('legacy prerequisite', undefined, {
      parentProposalId: proposal.id,
      spec: { files: [], verifyCmd: null, doneCriteria: [], mergeMode: 'auto', sliceKind: 'coder' },
    })
    const blocked = await q.enqueueTask('dependent legacy slice', undefined, {
      parentProposalId: proposal.id,
      spec: { files: [], verifyCmd: null, doneCriteria: [], mergeMode: 'auto', sliceKind: 'coder' },
    })
    await q.addBlockers(blocked.id, [blocker.id])
    const client = q.resolveQueueClient()
    await client.execute({
      sql: `UPDATE tasks SET status = 'draft' WHERE id IN (?, ?, ?)`,
      args: [queued.id, blocker.id, blocked.id],
    })
    const legacyKind = ['plan', 'approval'].join('-')
    await client.execute({
      sql: `INSERT INTO action_queue_items
              (id, kind, category, priority, state, title, body, payload, context, raised_by)
            VALUES (?, ?, 'orchestrator', 'high', 'open', 'Legacy planning gate', '', '{}', '{}', 'test')`,
      args: ['legacy-gate-row', legacyKind],
    })
    const bus = new EventEmitter()
    const queuedEvents: string[] = []
    bus.on('task.queued', ({ taskId }) => queuedEvents.push(taskId))

    const first = await reconcile.runStartupReconcile({ ...makeDeps(), bus })

    expect((await q.getTask(queued.id))?.status).toBe('queued')
    expect((await q.getTask(blocker.id))?.status).toBe('queued')
    expect((await q.getTask(blocked.id))?.status).toBe('blocked')
    expect(queuedEvents).toEqual(expect.arrayContaining([queued.id, blocker.id]))
    expect(first.retiredPlanGateRowsCleared).toBe(1)
    expect(first.legacySlicedDraftsReleased).toBe(3)
    const closed = await client.execute({
      sql: `SELECT state, resolution_note FROM action_queue_items WHERE id = ?`,
      args: ['legacy-gate-row'],
    })
    expect(closed.rows[0]).toMatchObject({
      state: 'resolved',
      resolution_note: 'superseded: retired planning gate',
    })

    const second = await reconcile.runStartupReconcile({ ...makeDeps(), bus: new EventEmitter() })
    expect(second.retiredPlanGateRowsCleared).toBe(0)
    expect(second.legacySlicedDraftsReleased).toBe(0)
  })
})

describe('runStartupReconcile — recovery-done propagation', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('flips a failed origin to done and re-queues its dependents when the fix task is done but propagation was missed', async () => {
    const { q, reconcile } = await loadModules(repo)

    // Create the origin task and force it to 'failed' (simulating the
    // retry-budget-exhaustion state after a failed code run).
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [origin.id],
    })

    // Create a dependent blocked on the origin.
    const dependent = await q.enqueueTask('dependent task', undefined, { skipTriage: true })
    // `task_blockers.created_at` is a bigint of epoch millis; `tasks`
    // `.created_at`/`updated_at` are timestamptz and take the ISO form.
    const now = new Date().toISOString()
    const nowMs = Date.now()
    await q.resolveQueueClient().execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
      args: [dependent.id, origin.id, nowMs],
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [dependent.id],
    })

    // Insert a done fix task pointing at the origin — this simulates a
    // recovery that completed (its FF-merge landed) but whose task.completed
    // event was never delivered to the propagation subscriber (e.g. daemon
    // crash between the merge commit and the outbox drain).
    const fixId = 'fix-reconcile-test-001'
    await q.resolveQueueClient().execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, fix_for_task_id, created_at, updated_at) VALUES (?, ?, 'done', 'fix', ?, ?, ?)`,
      args: [fixId, 'fix for origin', origin.id, now, now],
    })

    // Run reconcile — the recovery-done-propagation step should detect the
    // stranded scenario and replay propagateRecoveryDone().
    const summary = await reconcile.runStartupReconcile(makeDeps())

    // Origin must be flipped to 'done'.
    const updatedOrigin = await q.getTask(origin.id)
    expect(updatedOrigin?.status).toBe('done')

    // Dependent must be re-queued because its blocker (origin) is now done.
    const updatedDependent = await q.getTask(dependent.id)
    expect(updatedDependent?.status).toBe('queued')

    // Summary counters must reflect one propagation and one re-queued dependent.
    expect(summary.recoveryPropagated).toBe(1)
    expect(summary.recoveryDependentsRequeued).toBe(1)
  })

  it('is idempotent — second pass is a no-op when the origin is already done', async () => {
    const { q, reconcile } = await loadModules(repo)

    const origin = await q.enqueueTask('already-done origin', undefined, { skipTriage: true })
    const now = new Date().toISOString()
    // Origin already done before the reconcile runs (normal completion).
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [origin.id],
    })

    // Done fix task pointing at the origin.
    const fixId = 'fix-reconcile-test-002'
    await q.resolveQueueClient().execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, fix_for_task_id, created_at, updated_at) VALUES (?, ?, 'done', 'fix', ?, ?, ?)`,
      args: [fixId, 'fix for done origin', origin.id, now, now],
    })

    const first = await reconcile.runStartupReconcile(makeDeps())
    expect(first.recoveryPropagated).toBe(0) // origin already done → no-op

    const second = await reconcile.runStartupReconcile(makeDeps())
    expect(second.recoveryPropagated).toBe(0)

    // Origin stays done.
    const updated = await q.getTask(origin.id)
    expect(updated?.status).toBe('done')
  })

  it('does not touch fix tasks that are not yet done', async () => {
    const { q, reconcile } = await loadModules(repo)

    const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
    // See above: timestamptz columns take the ISO form, the bigint
    // `task_blockers.created_at` takes epoch millis.
    const now = new Date().toISOString()
    const nowMs = Date.now()

    // Fix task still running — should NOT trigger propagation.
    const fixId = 'fix-reconcile-test-003'
    await q.resolveQueueClient().execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, fix_for_task_id, created_at, updated_at) VALUES (?, ?, 'running', 'fix', ?, ?, ?)`,
      args: [fixId, 'running fix', origin.id, now, now],
    })

    // Block the origin on the in-progress fix task (real scenario: origin waits
    // for its recovery). This edge prevents the orphaned-blocked-scan from
    // spuriously re-queuing the origin before our step runs.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [origin.id],
    })
    await q.resolveQueueClient().execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
      args: [origin.id, fixId, nowMs],
    })

    const summary = await reconcile.runStartupReconcile(makeDeps())

    // No propagation — the fix task hasn't completed yet.
    expect(summary.recoveryPropagated).toBe(0)

    // Origin stays blocked (fix task still in-progress).
    const updated = await q.getTask(origin.id)
    expect(updated?.status).toBe('blocked')
  })
})

describe('runStartupReconcile — blocker-drift repair precedes orphan scan', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('demotes a drifted queued task before the orphan scan runs, keeping orphan re-queue correct', async () => {
    const { q, reconcile } = await loadModules(repo)

    // Set up drift: a queued task with an incomplete blocker.
    const blocker = await q.enqueueTask('incomplete blocker', undefined, { skipTriage: true })
    const drifted = await q.enqueueTask('drifted task', undefined, { skipTriage: true })
    await q.addBlockers(drifted.id, [blocker.id])
    // Force to queued despite having an incomplete blocker (invariant violation).
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'queued' WHERE id = ?`,
      args: [drifted.id],
    })

    // Set up an orphan: blocked with no edges.
    const orphan = await q.enqueueTask('orphan task', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [orphan.id],
    })

    const summary = await reconcile.runStartupReconcile(makeDeps())

    const updatedDrifted = await q.getTask(drifted.id)
    const updatedOrphan = await q.getTask(orphan.id)

    // Drift repair must have demoted the drifted task.
    expect(updatedDrifted?.status).toBe('blocked')
    expect(summary.blockerDriftRepaired).toBe(1)

    // Orphan scan must have promoted the orphan.
    // (The drifted task was demoted to blocked with a live blocker, so it stays blocked.)
    expect(updatedOrphan?.status).toBe('queued')
    expect(summary.orphanedBlockedRequeued).toBe(1)
  })
})

describe('runStartupReconcile — requeue-stale-running (prior-daemon running tasks)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('converts a prior-daemon running task to queued and emits task.queued on the bus', async () => {
    // Regression: tasks left in status='running' when the prior daemon died must
    // be converted to 'queued' by the requeue-stale-running reconciler before
    // reseed-dispatch fires, so they are dispatched on the new daemon. Without
    // this fix they stayed 'running' with no worker until the phantom-task
    // watchdog fired 30 min later and failed them.
    const { q, reconcile } = await loadModules(repo)
    const taskQueuedEvents: string[] = []
    const bus = new EventEmitter()
    bus.on('task.queued', (e: { taskId: string }) => taskQueuedEvents.push(e.taskId))

    // Simulate: task was running when the prior daemon died.
    const task = await q.enqueueTask('in-flight work from prior daemon', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', branch = NULL, worktree_path = NULL WHERE id = ?`,
      args: [task.id],
    })

    const summary = await reconcile.runStartupReconcile({
      log: () => {},
      bus,
      traceStore: null,
      handleProposalSlice: null,
    })

    // Task must be converted to 'queued' — never left as 'running' with no worker.
    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')

    // In-flight fields must be cleared so the next dispatch starts a clean setup.
    expect(updated?.branch).toBeNull()
    expect(updated?.worktreePath).toBeNull()
    expect(updated?.claudeSessionId).toBeNull()
    expect(updated?.error).toBeNull()

    // Summary must record the re-queue.
    expect(summary.runningRequeued).toBe(1)

    // Bus must have received task.queued so the dispatch loop picks it up.
    // Both requeue-stale-running and reseed-dispatch emit for this task —
    // at minimum one event must be present.
    expect(taskQueuedEvents).toContain(task.id)
  })

  it('ordering contract: a running task converted by requeue-stale-running is then picked up by reseed-dispatch', async () => {
    // Regression for the ordering bug: when reseed-dispatch ran BEFORE
    // requeue-stale-running, the bus emitted task.queued for all 'queued' rows
    // BEFORE prior-daemon 'running' rows were converted to 'queued'. The
    // converted tasks' bus events only came from requeue-stale-running (one
    // shot). Fixing the order means reseed-dispatch fires AFTER conversion so
    // it also emits for the newly-queued tasks — guaranteeing at least two
    // task.queued events per converted task (one from each step).
    const { q, reconcile } = await loadModules(repo)
    const taskQueuedEvents: string[] = []
    const bus = new EventEmitter()
    bus.on('task.queued', (e: { taskId: string }) => taskQueuedEvents.push(e.taskId))

    const task = await q.enqueueTask('ordering-regression work', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running' WHERE id = ?`,
      args: [task.id],
    })

    await reconcile.runStartupReconcile({
      log: () => {},
      bus,
      traceStore: null,
      handleProposalSlice: null,
    })

    // With the correct order (requeue before reseed), both steps emit task.queued:
    // requeue-stale-running emits once when it converts the task, then
    // reseed-dispatch emits again because the task is now 'queued'.
    const eventCount = taskQueuedEvents.filter((id) => id === task.id).length
    expect(eventCount).toBeGreaterThanOrEqual(2)
  })

  it('does not affect tasks already in queued status', async () => {
    // A task that was already 'queued' (e.g. never dispatched) must not be
    // touched by requeue-stale-running — it is already in the right state.
    const { q, reconcile } = await loadModules(repo)

    const task = await q.enqueueTask('normal queued work', undefined, { skipTriage: true })
    // task is already 'queued'

    const summary = await reconcile.runStartupReconcile({
      log: () => {},
      bus: new EventEmitter(),
      traceStore: null,
      handleProposalSlice: null,
    })

    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued') // unchanged
    expect(summary.runningRequeued).toBe(0) // not touched by requeue-stale-running
  })

  it('a running task restored to blocked (incomplete blockers) is not counted as requeued', async () => {
    // If the running task still has incomplete blockers it must be restored to
    // blocked, not queued — and must not appear in the runningRequeued count.
    const { q, reconcile } = await loadModules(repo)

    const blocker = await q.enqueueTask('incomplete blocker', undefined, { skipTriage: true })
    const task = await q.enqueueTask('task with blocker', undefined, { skipTriage: true })
    await q.addBlockers(task.id, [blocker.id])

    // Force the task to 'running' (simulating prior-daemon dispatch)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running' WHERE id = ?`,
      args: [task.id],
    })

    const summary = await reconcile.runStartupReconcile({
      log: () => {},
      bus: new EventEmitter(),
      traceStore: null,
      handleProposalSlice: null,
    })

    // Task must be restored to blocked (not queued), since it has an incomplete blocker.
    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('blocked')

    // runningRequeued counts only tasks promoted to 'queued', not to 'blocked'.
    expect(summary.runningRequeued).toBe(0)
  })
})

describe('runStartupReconcile — ghost-subscriber-sweep', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  /**
   * Import all subscriber modules so they self-register with the fresh
   * registry after vi.resetModules(). Must be called after loadModules(),
   * mirroring the daemon startup order (subscribers wired up before reconcile).
   */
  async function populateSubscriberRegistry(): Promise<void> {
    await import('../alert-dismisser')
    await import('../action-queue-repopulator')
    await import('../../../outbox/subscribers/invalidator')
    await import('../../../outbox/subscribers/blocker-resolution')
    await import('../../../outbox/subscribers/recovery-spawn')
    await import('../../../outbox/subscribers/idea-lifecycle')
    await import('../../../outbox/subscribers/signal-recording')
    await import('../../../outbox/subscribers/transcript-append')
    await import('../../../outbox/subscribers/question-raise')
    await import('../../../outbox/subscribers/action-queue-raisers')
  }

  it('removes a ghost subscriber row and its processed-events while legitimate subscribers survive', async () => {
    const { q, reconcile } = await loadModules(repo)
    await populateSubscriberRegistry()
    const client = q.resolveQueueClient()

    // Create the subscribers and dedup tables (normally created lazily at first
    // registerSubscriber / processedOnce call; we seed them manually here).
    const { ensureSubscribersSchema } = await import('../../../bus/subscribers')
    const { ensureProcessedOnceSchema } = await import('../../../bus/processed-once')
    await ensureSubscribersSchema(client)
    await ensureProcessedOnceSchema(client)

    // Seed a ghost subscriber: 'inbox-repopulator' was the old name for
    // 'action-queue-repopulator' and is no longer code-declared.
    await client.execute({
      sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?)',
      args: ['inbox-repopulator', 7470],
    })

    // Seed a legitimate subscriber that must NOT be removed.
    await client.execute({
      sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?)',
      args: ['action-queue-repopulator', 7784],
    })

    // Seed processed-event rows for both subscribers.
    await client.execute({
      sql: 'INSERT INTO subscriber_processed_events (subscriber_id, event_id) VALUES (?, ?)',
      args: ['inbox-repopulator', 100],
    })
    await client.execute({
      sql: 'INSERT INTO subscriber_processed_events (subscriber_id, event_id) VALUES (?, ?)',
      args: ['action-queue-repopulator', 100],
    })

    const summary = await reconcile.runStartupReconcile(makeDeps())

    // Ghost subscriber row must be gone.
    const ghostRow = await client.execute({
      sql: 'SELECT name FROM subscribers WHERE name = ?',
      args: ['inbox-repopulator'],
    })
    expect(ghostRow.rows).toHaveLength(0)

    // Ghost processed-events rows must be gone.
    const ghostSPE = await client.execute({
      sql: 'SELECT * FROM subscriber_processed_events WHERE subscriber_id = ?',
      args: ['inbox-repopulator'],
    })
    expect(ghostSPE.rows).toHaveLength(0)

    // Legitimate subscriber row must survive.
    const legitRow = await client.execute({
      sql: 'SELECT name FROM subscribers WHERE name = ?',
      args: ['action-queue-repopulator'],
    })
    expect(legitRow.rows).toHaveLength(1)

    // Legitimate processed-events rows must survive.
    const legitSPE = await client.execute({
      sql: 'SELECT * FROM subscriber_processed_events WHERE subscriber_id = ?',
      args: ['action-queue-repopulator'],
    })
    expect(legitSPE.rows).toHaveLength(1)

    // Summary counter must reflect the one ghost that was removed.
    expect(summary.ghostSubscribersSwept).toBe(1)
  })

  it('is a no-op when the subscribers table does not exist yet', async () => {
    const { reconcile } = await loadModules(repo)
    await populateSubscriberRegistry()

    // Do NOT create the subscribers table — it may not exist on a fresh DB.
    const summary = await reconcile.runStartupReconcile(makeDeps())

    // Step must complete without error and report zero sweeps.
    expect(summary.ghostSubscribersSwept).toBe(0)
  })

  it('treats alert-dismisser as a known subscriber and does not delete it', async () => {
    // Regression for the registration-order race: the ghost-subscriber-sweep
    // was deleting 'alert-dismisser' because ALERT_DISMISSER_SUBSCRIBER was
    // missing from the knownNames set, even though it is code-declared.
    const { q, reconcile } = await loadModules(repo)
    await populateSubscriberRegistry()
    const client = q.resolveQueueClient()

    const { ensureSubscribersSchema } = await import('../../../bus/subscribers')
    await ensureSubscribersSchema(client)

    // Seed the alert-dismisser subscriber row (as ensureAlertDismisser would).
    await client.execute({
      sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?)',
      args: ['alert-dismisser', 0],
    })

    // Seed a true ghost that should be removed.
    await client.execute({
      sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?)',
      args: ['old-ghost-subscriber', 999],
    })

    const summary = await reconcile.runStartupReconcile(makeDeps())

    // alert-dismisser must NOT be swept — it is code-declared.
    const alertRow = await client.execute({
      sql: 'SELECT name FROM subscribers WHERE name = ?',
      args: ['alert-dismisser'],
    })
    expect(alertRow.rows).toHaveLength(1)

    // The actual ghost must be swept.
    const ghostRow = await client.execute({
      sql: 'SELECT name FROM subscribers WHERE name = ?',
      args: ['old-ghost-subscriber'],
    })
    expect(ghostRow.rows).toHaveLength(0)

    // Only the one true ghost was swept.
    expect(summary.ghostSubscribersSwept).toBe(1)
  })
})

describe('runStartupReconcile — vega-reconciling-recovery integration', () => {
  /**
   * Integration regression for the bug where tasks stranded in
   * `vega-reconciling` after a daemon restart were never recovered.
   *
   * These tests verify the wiring from `runStartupReconcile` →
   * `vegaReconcilingRecovery` reconciler → `recoverPhase('vega-reconciling')`.
   * The per-function unit tests live in phase-recovery-vega-reconciling.test.ts;
   * these verify the reconciler is registered and plumbed correctly and that
   * the `vegaReconcilingRequeued` summary counter is accumulated end-to-end.
   */

  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('requeues a vega-reconciling task and emits task.queued on the bus', async () => {
    // Regression: a task stuck in vega-reconciling (Vega/vcs-supervisor was
    // running when the daemon died) must be re-queued from setup, not left
    // stranded indefinitely.
    const { q, reconcile } = await loadModules(repo)
    const taskQueuedEvents: string[] = []
    const bus = new EventEmitter()
    bus.on('task.queued', (e: { taskId: string }) => taskQueuedEvents.push(e.taskId))

    // Simulate: a task was in vega-reconciling when the prior daemon died.
    // branch and worktree_path are null (cleared or never set in this simulation).
    const task = await q.enqueueTask('vega-reconciling work', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'vega-reconciling', branch = NULL, worktree_path = NULL WHERE id = ?`,
      args: [task.id],
    })

    const summary = await reconcile.runStartupReconcile({
      log: () => {},
      bus,
      traceStore: null,
      handleProposalSlice: null,
    })

    // Task must be re-queued from setup — never left in vega-reconciling.
    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('queued')

    // In-flight fields must be cleared so the next dispatch starts clean.
    expect(updated?.branch).toBeNull()
    expect(updated?.worktreePath).toBeNull()
    expect(updated?.claudeSessionId).toBeNull()
    expect(updated?.error).toBeNull()

    // Summary counter must reflect the re-queue.
    expect(summary.vegaReconcilingRequeued).toBe(1)
    expect(summary.vegaReconcilingFinalized).toBe(0)

    // Bus must emit task.queued so the dispatch loop picks it up.
    // Both vega-reconciling-recovery and reseed-dispatch emit for the task —
    // at minimum one event must be present.
    expect(taskQueuedEvents).toContain(task.id)
  })

  it('restores a vega-reconciling task to blocked when it has incomplete blockers', async () => {
    // A vega-reconciling task with a live (non-done) blocker must be
    // restored to blocked, not queued — its dependency is still outstanding.
    const { q, reconcile } = await loadModules(repo)

    const blocker = await q.enqueueTask('incomplete blocker', undefined, { skipTriage: true })
    const task = await q.enqueueTask('vega-reconciling with active blocker', undefined, {
      skipTriage: true,
    })
    await q.addBlockers(task.id, [blocker.id])

    // Force the task to vega-reconciling.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'vega-reconciling' WHERE id = ?`,
      args: [task.id],
    })

    const summary = await reconcile.runStartupReconcile({
      log: () => {},
      bus: new EventEmitter(),
      traceStore: null,
      handleProposalSlice: null,
    })

    // Task must be restored to blocked (not queued) — the blocker is still
    // outstanding and the task must not be dispatched without it.
    const updated = await q.getTask(task.id)
    expect(updated?.status).toBe('blocked')

    // A task restored to blocked is NOT counted in vegaReconcilingRequeued.
    expect(summary.vegaReconcilingRequeued).toBe(0)
    expect(summary.vegaReconcilingFinalized).toBe(0)
  })

  it('is a no-op when there are no vega-reconciling tasks', async () => {
    // Belt-and-suspenders: a daemon restart with no stuck Vega sessions must
    // not touch any tasks or emit spurious events.
    const { q, reconcile } = await loadModules(repo)

    // Seed a normal queued task (not vega-reconciling) to ensure the step
    // does not disturb unrelated rows.
    await q.enqueueTask('normal queued work', undefined, { skipTriage: true })

    const summary = await reconcile.runStartupReconcile({
      log: () => {},
      bus: new EventEmitter(),
      traceStore: null,
      handleProposalSlice: null,
    })

    expect(summary.vegaReconcilingRequeued).toBe(0)
    expect(summary.vegaReconcilingFinalized).toBe(0)
  })
})
