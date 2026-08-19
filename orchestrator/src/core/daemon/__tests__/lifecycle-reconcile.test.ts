import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Client } from '@libsql/client'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
}

interface ActionQueueModule {
  initActionQueue: typeof import('../../lib/action-queue').initActionQueue
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
}

interface ReconcileModule {
  reconcileTerminalTasks: typeof import('../lifecycle-reconcile').reconcileTerminalTasks
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-lifecycle-reconcile-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Load every module against the same temp repo. `MARS_REPO` makes
 * `resolveContext()` resolve `stateDbPath`/`queueDbPath` to one
 * `.mars/mars.db`, so the tasks table and action_queue_items share a
 * single libsql client.
 */
const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  await actionQueue.initActionQueue()
  const reconcile = (await import('../lifecycle-reconcile')) as unknown as ReconcileModule
  return { q, actionQueue, reconcile }
}

const insertTask = async (client: Client, id: string, status: string): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, 'test prompt', status, new Date().toISOString(), new Date().toISOString()],
  })
}

describe('reconcileTerminalTasks', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('resolves open rows for terminal tasks, leaving live tasks untouched', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed: 'done' task with an open action queue row.
    const doneTaskId = 'T-done'
    await insertTask(client, doneTaskId, 'done')
    const doneItemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${doneTaskId} needs attention`,
      body: 'stuck',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: `sig-${doneTaskId}`,
      originTaskId: doneTaskId,
    })

    // Seed: live 'queued' task with an open action queue row — must be untouched.
    const queuedTaskId = 'T-queued'
    await insertTask(client, queuedTaskId, 'queued')
    const queuedItemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${queuedTaskId} needs attention`,
      body: 'stuck',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: `sig-${queuedTaskId}`,
      originTaskId: queuedTaskId,
    })

    const { rowsResolved } = await reconcile.reconcileTerminalTasks(client)

    // Done task's action queue row must be resolved.
    const doneItem = await actionQueue.getActionQueueItem(doneItemId)
    expect(doneItem).not.toBeNull()
    expect(doneItem!.status).toBe('resolved')

    // Live queued task's row must remain open.
    const queuedItem = await actionQueue.getActionQueueItem(queuedItemId)
    expect(queuedItem).not.toBeNull()
    expect(queuedItem!.status).toBe('open')

    // Return counts must reflect what was processed.
    expect(rowsResolved).toBe(1)
  })

  // NOTE: the former "stale-worktree rows ... payload.originalTaskId"
  // coverage that lived here was deleted (not rewritten) — `stale-worktree`
  // is now a CONDITION_KINDS entry (action-queue-kinds.ts): it is derived on
  // every read from worktree mtimes (`deriveStaleWorktreeConditions` in
  // view/derived-conditions.ts) and never stored as an `action_queue_items`
  // row. `raiseActionQueueItem` still accepts the kind, but the row it writes
  // is deleted by the very next `ensureSchema` pass (pg-schema.ts's
  // condition-kind cleanup), so `getActionQueueItem` can never observe it —
  // confirmed empirically, not just by reading the source. No production
  // code path populates `payload.originalTaskId` any more either (it was
  // specific to the old stale-worktree raiser), so the (b-null-done) leg in
  // lifecycle-reconcile.ts this test exercised is dead in practice. Filed as
  // a cleanup proposal rather than deleted inline here, since that file is
  // outside this task's scope.

  it('is idempotent: a second call after everything is already clean is a no-op', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const doneTaskId = 'T-done2'
    await insertTask(client, doneTaskId, 'done')
    await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${doneTaskId} needs attention`,
      body: 'stuck',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: `sig-${doneTaskId}`,
      originTaskId: doneTaskId,
    })

    const first = await reconcile.reconcileTerminalTasks(client)
    const second = await reconcile.reconcileTerminalTasks(client)

    expect(first.rowsResolved).toBe(1)
    // After the first pass the row is resolved, so the second pass finds nothing.
    expect(second.rowsResolved).toBe(0)
  })

  it('closes recovery-abandoned rows whose origin task is done (signature-based sweep)', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Origin task is terminal (done).
    const originId = 'T-origin-done'
    await insertTask(client, originId, 'done')

    // Raise a recovery-abandoned row with NULL origin_task_id (simulates a
    // legacy row raised before origin_task_id was populated), relying only on
    // the signature to identify the origin.
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'recovery-abandoned',
      category: 'orchestrator',
      priority: 'high',
      title: 'Recovery task dropped',
      body: `Run mars continue ${originId}`,
      payload: { fixTaskId: 'fix-xxxx', originTaskId: originId },
      context: {},
      raisedBy: 'test',
      signature: `recovery-abandoned:${originId}`,
      // intentionally no originTaskId — simulates the NULL origin_task_id case
    })

    const { rowsResolved } = await reconcile.reconcileTerminalTasks(client)

    expect(rowsResolved).toBeGreaterThanOrEqual(1)
    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.status).toBe('resolved')
    expect(item!.resolution).toBe('superseded')
  })

  it('leaves recovery-abandoned rows open when origin task is still failed', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Origin task is still failed (not terminal).
    const originId = 'T-origin-failed'
    await insertTask(client, originId, 'failed')

    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'recovery-abandoned',
      category: 'orchestrator',
      priority: 'high',
      title: 'Recovery task dropped',
      body: `Run mars continue ${originId}`,
      payload: { fixTaskId: 'fix-yyyy', originTaskId: originId },
      context: {},
      raisedBy: 'test',
      signature: `recovery-abandoned:${originId}`,
    })

    await reconcile.reconcileTerminalTasks(client)

    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.status).toBe('open')
  })
})
