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
    expect(doneItem!.state).toBe('resolved')

    // Live queued task's row must remain open.
    const queuedItem = await actionQueue.getActionQueueItem(queuedItemId)
    expect(queuedItem).not.toBeNull()
    expect(queuedItem!.state).toBe('open')

    // Return counts must reflect what was processed.
    expect(rowsResolved).toBe(1)
  })

  it('closes stale-worktree rows (NULL origin_task_id) whose payload.originalTaskId is a done task', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed a task that has completed — the origin of the stale-worktree row.
    const doneTaskId = 'T-sw-done'
    await insertTask(client, doneTaskId, 'done')

    // Seed a stale-worktree item as recovery runs raise it: no originTaskId
    // (so origin_task_id stays NULL), but payload carries originalTaskId.
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'stale-worktree',
      category: 'orchestrator',
      priority: 'high',
      title: 'Stale worktree detected',
      body: 'worktree left over from a crashed recovery run',
      payload: { originalTaskId: doneTaskId, recoveryTaskId: 'fix-xxxx' },
      context: {},
      raisedBy: 'test',
      signature: `stale-worktree:${doneTaskId}`,
      // intentionally no originTaskId — this is the bug scenario
    })

    const { rowsResolved } = await reconcile.reconcileTerminalTasks(client)

    expect(rowsResolved).toBeGreaterThanOrEqual(1)
    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.state).toBe('resolved')
    expect(item!.resolution).toBe('superseded')
  })

  it('leaves stale-worktree rows open when payload.originalTaskId points at a non-terminal task', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed a task that is still active.
    const queuedTaskId = 'T-sw-queued'
    await insertTask(client, queuedTaskId, 'queued')

    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'stale-worktree',
      category: 'orchestrator',
      priority: 'high',
      title: 'Stale worktree detected',
      body: 'worktree from a recovery run whose origin is still running',
      payload: { originalTaskId: queuedTaskId, recoveryTaskId: 'fix-yyyy' },
      context: {},
      raisedBy: 'test',
      signature: `stale-worktree:${queuedTaskId}`,
      // intentionally no originTaskId
    })

    await reconcile.reconcileTerminalTasks(client)

    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.state).toBe('open')
  })

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
})
