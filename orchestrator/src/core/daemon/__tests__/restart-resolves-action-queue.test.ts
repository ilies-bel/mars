/**
 * End-to-end tests confirming that restarting a failed task (and driving it
 * to done) properly resolves the original failed action-queue row.
 *
 * Acceptance criterion (b) from the auto-dismiss task:
 *   "restarting a failed task and driving it to done resolves the
 *    original failed row"
 *
 * The mechanism under test:
 *   coreRestartTask → updateTask({ status: 'queued' })
 *     → emits task.queued into the outbox
 *   drainAlertDismissals processes task.queued
 *     → dismissAlertsOnStatusChange(taskId, 'queued')
 *     → resolves the stale failure row keyed by computeOriginFingerprint(taskId)
 *
 * The "drive to done" step verifies that:
 *   - The row stays resolved after the task completes (not re-raised)
 *   - task.completed → resolveAllRowsForTask (idempotent — already resolved)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { InMemoryStore } from '@mars/workflow'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
}

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
  initActionQueue: typeof import('../../lib/action-queue').initActionQueue
}

interface AlertDismisserModule {
  ensureAlertDismisser: typeof import('../alert-dismisser').ensureAlertDismisser
  drainAlertDismissals: typeof import('../alert-dismisser').drainAlertDismissals
}

interface RestartTaskModule {
  coreRestartTask: typeof import('../restart-task').coreRestartTask
}

interface ReconcileModule {
  reconcileTerminalTasks: typeof import('../lifecycle-reconcile').reconcileTerminalTasks
}

interface Loaded {
  q: QueueModule
  actionQueue: ActionQueueModule
  ad: AlertDismisserModule
  restart: RestartTaskModule
}

/** Create a minimal git repo with one commit on main so git operations work. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-restart-aq-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return repo
}

const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  await actionQueue.initActionQueue()
  const ad = (await import('../alert-dismisser')) as unknown as AlertDismisserModule
  const restart = (await import('../restart-task')) as unknown as RestartTaskModule
  return { q, actionQueue, ad, restart }
}

describe('restart → done auto-dismisses the failed action-queue row', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('restarting a failed task resolves its action-queue row after event drain (via task.queued)', async () => {
    // This confirms the restart path: coreRestartTask → updateTask({queued})
    // → task.queued event → drainAlertDismissals → dismissAlertsOnStatusChange
    // closes the stale failure row.
    const { q, actionQueue, ad, restart } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed a failed task.
    const task = await q.enqueueTask('restart-aq test', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'failed', error: 'boom' })

    // Raise an open action-queue row for the failed task.
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${task.id} failed`,
      body: 'stuck',
      payload: {},
      context: { task_id: task.id },
      raisedBy: 'orchestrator:test',
      signature: `sig-restart-${task.id}`,
      originTaskId: task.id,
    })

    // Register the Invalidator subscriber AFTER seeding so pre-restart events
    // are behind the cursor (mirrors the daemon's boot sequence).
    await ad.ensureAlertDismisser(client)

    // Restart the task — this calls updateTask({status:'queued'}) which emits
    // task.queued into the outbox. The branch doesn't exist; git branch -D fails
    // silently (.catch(() => {}) in coreRestartTask).
    await restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore())

    // Verify the task is re-queued.
    const requeued = await (q as unknown as { getTask: (id: string) => Promise<{ status: string } | null> }).getTask(task.id)
    expect(requeued?.status).toBe('queued')

    // Drain: processes the task.queued event → closes the stale failure row.
    const { processed } = await ad.drainAlertDismissals(client)
    expect(processed).toBeGreaterThanOrEqual(1)

    const afterRestart = await actionQueue.getActionQueueItem(itemId)
    expect(afterRestart!.state).toBe('resolved')
  })

  it('driving the restarted task to done keeps the action-queue row resolved (not re-raised)', async () => {
    // After restart, the task completes. The row must stay resolved — the
    // repopulator must NOT re-raise for task.completed, and the Invalidator
    // resolveAllRowsForTask is idempotent (row already resolved).
    const { q, actionQueue, ad, restart } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const task = await q.enqueueTask('restart-done-aq test', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'failed', error: 'boom' })

    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${task.id} failed`,
      body: 'stuck',
      payload: {},
      context: { task_id: task.id },
      raisedBy: 'orchestrator:test',
      signature: `sig-restart-done-${task.id}`,
      originTaskId: task.id,
    })

    await ad.ensureAlertDismisser(client)

    // Restart → row closed by task.queued drain.
    await restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore())
    await ad.drainAlertDismissals(client)

    const afterRestart = await actionQueue.getActionQueueItem(itemId)
    expect(afterRestart!.state).toBe('resolved')

    // Drive to done: task.completed → Invalidator resolveAllRowsForTask
    // (already resolved — idempotent, no error).
    await q.updateTask(task.id, { status: 'done' })
    const { processed } = await ad.drainAlertDismissals(client)

    // task.completed processes (resolveAllRowsForTask is idempotent).
    expect(processed).toBeGreaterThanOrEqual(1)

    // Row must remain resolved — not re-opened by any path.
    const afterDone = await actionQueue.getActionQueueItem(itemId)
    expect(afterDone!.state).toBe('resolved')
  })

  it('reconcileTerminalTasks resolves an open row whose origin task is already done (daemon-boot backstop)', async () => {
    // This is test (c) from the brief: a daemon reconcile pass resolves an
    // open row whose origin task is already in a terminal status.
    // Covers the race where the Invalidator's event drain was skipped (e.g.
    // daemon crashed between the status write and drain) and the reconciler
    // runs on the next boot as a backstop.
    const { q, actionQueue } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const reconcile = (await import('../lifecycle-reconcile')) as unknown as ReconcileModule

    // Seed a done task that still has an open action-queue row — simulating
    // the daemon-crash gap where the Invalidator drain was never run.
    const task = await q.enqueueTask('reconcile-done-aq test', undefined, { skipTriage: true })
    // Write failed then done to simulate a task that went through recovery.
    await q.updateTask(task.id, { status: 'failed', error: 'transient' })

    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${task.id} failed`,
      body: 'stuck',
      payload: {},
      context: { task_id: task.id },
      raisedBy: 'orchestrator:test',
      signature: `sig-reconcile-${task.id}`,
      originTaskId: task.id,
    })

    // Simulate recovery completing — task reaches 'done' without the event
    // drain having cleared the stale row (daemon was briefly down).
    await q.updateTask(task.id, { status: 'done' })

    // Confirm the row is still open (the Invalidator didn't run).
    const before = await actionQueue.getActionQueueItem(itemId)
    expect(before!.state).toBe('open')

    // Run reconcileTerminalTasks — the daemon-boot backstop.
    const { rowsResolved } = await reconcile.reconcileTerminalTasks(client)
    expect(rowsResolved).toBeGreaterThanOrEqual(1)

    // The row must be resolved by the reconciler.
    const after = await actionQueue.getActionQueueItem(itemId)
    expect(after!.state).toBe('resolved')
  })

  it('reconcileTerminalTasks resolves a stranded row for a sliced task whose origin_task_id is a still-running PRD task (payload.taskId leg)', async () => {
    // Regression: when a task is sliced from a PRD that itself exists as a task
    // (still queued/running — other slices are pending), raiseActionQueueItem stores
    // origin_task_id = prdTaskId (the arc root). The existing reconcile legs miss
    // this row because:
    //   leg (a): JOIN on origin_task_id = t.id WHERE t.status IN ('done','dropped')
    //            — the PRD task is still 'queued', not done/dropped → no match.
    //   leg (b-task): WHERE origin_task_id NOT IN (SELECT id FROM tasks)
    //            — the PRD task IS in the tasks table → no match.
    // The new leg (c) joins via json_extract(payload, '$.taskId') against the
    // actual failed task id (which is done), regardless of the PRD's status.
    const { q, actionQueue } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const reconcile = (await import('../lifecycle-reconcile')) as unknown as ReconcileModule

    const now = new Date().toISOString()
    // PRD task: still queued (other slices running) — NOT a terminal state.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, kind, created_at, updated_at)
            VALUES (?, ?, 'queued', ?, 0, 'task', ?, ?)`,
      args: ['prd-task-still-running', '(prd prompt)', null, now, now],
    })
    // Sliced task: failed, then done (recovered), origin_id → PRD task id.
    await client.execute({
      sql: `INSERT INTO tasks (
              id, prompt, status, origin_id, recovery_spawned_count,
              failure_reason, failure_reason_code,
              kind, recovery_payload,
              failure_signature, error,
              created_at, updated_at
            ) VALUES (?, ?, 'done', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        'T-sliced-done-001', '(test prompt)', 'prd-task-still-running',
        null, null, 'task', null, null, null, now, now,
      ],
    })

    // Raise a failed row as the repopulator does.
    // raiseActionQueueItem resolves 'T-sliced-done-001' → 'prd-task-still-running'
    // and stores origin_task_id = 'prd-task-still-running',
    //            fingerprint = sha1('origin:prd-task-still-running').
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: 'Sliced task failed',
      body: 'could not install',
      payload: { taskId: 'T-sliced-done-001' },
      context: {},
      raisedBy: 'orchestrator:test',
      signature: 'T-sliced-done-001',
      originTaskId: 'T-sliced-done-001',
    })

    // Confirm the row is open and stored with the PRD's id as origin_task_id.
    const before = await actionQueue.getActionQueueItem(itemId)
    expect(before!.state).toBe('open')
    expect(before!.originTaskId).toBe('prd-task-still-running')

    // leg (a) won't find it (PRD task is 'queued', not done/dropped).
    // leg (b-task) won't find it (PRD task IS in tasks table).
    // leg (c) MUST find it via payload.taskId = 'T-sliced-done-001' (status 'done').
    const { rowsResolved } = await reconcile.reconcileTerminalTasks(client)
    expect(rowsResolved).toBeGreaterThanOrEqual(1)

    const after = await actionQueue.getActionQueueItem(itemId)
    expect(after!.state).toBe('resolved')
  })
})
