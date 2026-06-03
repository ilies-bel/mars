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

interface DismissalsModule {
  dismissEntity: typeof import('../../lib/action-queue-dismissals').dismissEntity
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
 * `.mars/mars.db`, so the tasks table, action_queue_items, and
 * action_queue_dismissals all share a single libsql client.
 */
const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  await actionQueue.initActionQueue()
  const dismissals = (await import(
    '../../lib/action-queue-dismissals'
  )) as unknown as DismissalsModule
  const reconcile = (await import('../lifecycle-reconcile')) as unknown as ReconcileModule
  return { q, actionQueue, dismissals, reconcile }
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

  it('resolves open rows for terminal tasks and clears orphaned dismissals, leaving live tasks untouched', async () => {
    const { q, actionQueue, dismissals, reconcile } = await loadModules(repo)
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

    // Seed: deleted task with a lingering dismissal (absent from tasks table).
    const deletedTaskId = 'T-deleted'
    await dismissals.dismissEntity('task', deletedTaskId, { by: 'op' })

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

    const { rowsResolved, dismissalsCleared } = await reconcile.reconcileTerminalTasks(client)

    // Done task's action queue row must be resolved.
    const doneItem = await actionQueue.getActionQueueItem(doneItemId)
    expect(doneItem).not.toBeNull()
    expect(doneItem!.state).toBe('resolved')

    // Orphaned dismissal for the deleted task must be gone.
    const orphanCheck = await client.execute({
      sql: `SELECT 1 FROM action_queue_dismissals
             WHERE entity_kind = 'task' AND entity_id = ? LIMIT 1`,
      args: [deletedTaskId],
    })
    expect(orphanCheck.rows).toHaveLength(0)

    // Live queued task's row must remain open.
    const queuedItem = await actionQueue.getActionQueueItem(queuedItemId)
    expect(queuedItem).not.toBeNull()
    expect(queuedItem!.state).toBe('open')

    // Return counts must reflect what was processed.
    expect(rowsResolved).toBe(1)
    expect(dismissalsCleared).toBe(1)
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
    expect(second.dismissalsCleared).toBe(0)
  })
})
