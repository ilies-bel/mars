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
    const now = new Date().toISOString()
    await q.resolveQueueClient().execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
      args: [dependent.id, origin.id, now],
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
    const now = new Date().toISOString()

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
      args: [origin.id, fixId, now],
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
