/**
 * Tests for the `setActionQueueState(..., 'resolved', ...)` write path on
 * task.dropped-derived rows — the sole row-closer (driven by the Invalidator).
 *
 * For task.dropped rows there is no eviction event to auto-close them, so the
 * 'resolved' write must persist the row closure on `action_queue_items.state`,
 * and a subsequent `reconcileTerminalTasks` pass must not re-open it.
 */

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
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  setActionQueueState: typeof import('../../lib/action-queue').setActionQueueState
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
}

interface ReconcileModule {
  reconcileTerminalTasks: typeof import('../lifecycle-reconcile').reconcileTerminalTasks
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-aq-resolve-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Reload all modules against an isolated temp repo. MARS_REPO makes
 * resolveContext() point stateDbPath/queueDbPath at a single .mars/mars.db so
 * all tables share one DB — the same pattern used in
 * action-queue-repopulator.test.ts.
 */
const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; actionQueue: ActionQueueModule; reconcile: ReconcileModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const reconcile = (await import('../lifecycle-reconcile')) as unknown as ReconcileModule
  return { q, actionQueue, reconcile }
}

/**
 * Insert a minimal dropped task row. The repopulator reads this row when
 * processing task.dropped events; reconcileTerminalTasks joins on it to find
 * open action-queue items for terminal tasks.
 */
const insertDroppedTask = async (client: Client, taskId: string): Promise<void> => {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO tasks (
            id, prompt, status, origin_id, recovery_spawned_count,
            failure_reason, failure_reason_code,
            kind, recovery_payload,
            failure_signature, error,
            created_at, updated_at
          ) VALUES (?, ?, 'dropped', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [taskId, '(test prompt)', taskId, null, null, 'task', null, null, null, now, now],
  })
}

describe('setActionQueueState resolved — task.dropped-derived rows', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('setActionQueueState flips a task.dropped-derived row to resolved and sets resolved_at', async () => {
    const { q, actionQueue } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-dropped-resolve'

    await insertDroppedTask(client, taskId)

    // Raise a row exactly as the repopulator does for task.dropped events
    await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: 'Task dropped',
      body: 'Task was dropped',
      payload: { taskId },
      context: {},
      raisedBy: 'system',
      signature: taskId,
      originTaskId: taskId,
    })

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row, 'open row must exist after raise').toBeDefined()
    expect(row!.state).toBe('open')
    expect(row!.resolvedAt).toBeNull()
    expect(row!.resolution).toBeNull()

    // Close the row via the Invalidator's resolve write path
    await actionQueue.setActionQueueState(row!.id, 'resolved', { note: 'invalidator-resolved' })

    const resolved = await actionQueue.getActionQueueItem(row!.id)
    expect(resolved?.state).toBe('resolved')
    expect(resolved?.resolvedAt).not.toBeNull()
    expect(typeof resolved?.resolvedAt).toBe('number')
    expect(resolved?.resolution).not.toBeNull()
  })

  it('resolved task.dropped row stays resolved after reconcileTerminalTasks (no revert)', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-dropped-reconcile'

    await insertDroppedTask(client, taskId)

    await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: 'Task dropped',
      body: 'Task was dropped',
      payload: { taskId },
      context: {},
      raisedBy: 'system',
      signature: taskId,
      originTaskId: taskId,
    })

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row, 'open row must exist after raise').toBeDefined()

    // The Invalidator closes the row via the resolve write path
    await actionQueue.setActionQueueState(row!.id, 'resolved', { note: 'invalidator-resolved' })

    // Simulate a daemon restart: reconcileTerminalTasks runs on startup.
    // The row is already resolved — reconcile must not touch it.
    const { rowsResolved } = await reconcile.reconcileTerminalTasks(client)
    expect(rowsResolved).toBe(0)

    const after = await actionQueue.getActionQueueItem(row!.id)
    expect(after?.state).toBe('resolved')
  })
})
