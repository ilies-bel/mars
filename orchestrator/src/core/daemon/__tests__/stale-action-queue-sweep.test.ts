/**
 * Tests for the `stale-action-queue-sweep` reconciler step.
 *
 * Asserts two key behaviours:
 *   1. When a task that has an open `failed`-kind action-queue item transitions
 *      to `done`, the reconciler resolves (closes) the item automatically.
 *   2. An open item for a task that is still `failed` is left open — the
 *      operator must resolve it manually.
 *
 * These tests drive the reconciler through `runStartupReconcile` (the full
 * startup-reconcile pass) so the assertions are against observable behaviour
 * rather than internal implementation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'

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
  runStartupReconcile: typeof import('../startup-reconcile').runStartupReconcile
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-stale-aq-sweep-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  await actionQueue.initActionQueue()
  const reconcile = (await import('../startup-reconcile')) as unknown as ReconcileModule
  return { q, actionQueue, reconcile }
}

const makeDeps = () => ({
  log: (_line: string): void => {},
  bus: new EventEmitter(),
  traceStore: null as null,
  handleProposalSlice: null as null,
})

const insertTask = async (
  client: ReturnType<QueueModule['resolveQueueClient']>,
  id: string,
  status: string,
): Promise<void> => {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, 'test prompt', status, now, now],
  })
}

describe('stale-action-queue-sweep reconciler step', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('auto-resolves an open failed-task action-queue item when the task is done', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed: task that reached 'done' but has an open action-queue item.
    const doneTaskId = 'T-done-has-alert'
    await insertTask(client, doneTaskId, 'done')
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: 'A pipeline step did not complete',
      body: 'Task blocked at code step.',
      payload: { taskId: doneTaskId },
      context: {},
      raisedBy: 'test',
      signature: `task.blocked:${doneTaskId}`,
      originTaskId: doneTaskId,
    })

    // Verify the item is open before the reconcile.
    const before = await actionQueue.getActionQueueItem(itemId)
    expect(before?.state).toBe('open')

    // Run the full startup-reconcile pass (includes stale-action-queue-sweep).
    const summary = await reconcile.runStartupReconcile(makeDeps())

    // Item must be resolved.
    const after = await actionQueue.getActionQueueItem(itemId)
    expect(after?.state).toBe('resolved')

    // Summary must report the closure.
    expect(summary.staleActionQueueItemsResolved).toBeGreaterThanOrEqual(1)
  })

  it('leaves an open item for a still-failed task untouched', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed: task that is still 'failed' — its alert must remain open.
    const failedTaskId = 'T-failed-keeps-alert'
    await insertTask(client, failedTaskId, 'failed')
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: 'A pipeline step did not complete',
      body: 'Task failed and needs operator attention.',
      payload: { taskId: failedTaskId },
      context: {},
      raisedBy: 'test',
      signature: `task.failed:${failedTaskId}`,
      originTaskId: failedTaskId,
    })

    await reconcile.runStartupReconcile(makeDeps())

    // Item must remain open — a 'failed' task still needs operator attention.
    const after = await actionQueue.getActionQueueItem(itemId)
    expect(after?.state).toBe('open')
  })

  it('correctly distinguishes done and failed tasks in the same pass', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Done task → item should be resolved.
    const doneTaskId = 'T-done-mixed'
    await insertTask(client, doneTaskId, 'done')
    const doneItemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: 'Phantom alert for done task',
      body: 'This alert was not dismissed when the task completed.',
      payload: { taskId: doneTaskId },
      context: {},
      raisedBy: 'test',
      signature: `stale:${doneTaskId}`,
      originTaskId: doneTaskId,
    })

    // Failed task → item should stay open.
    const failedTaskId = 'T-failed-mixed'
    await insertTask(client, failedTaskId, 'failed')
    const failedItemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: 'Legitimate alert for failed task',
      body: 'Operator action required.',
      payload: { taskId: failedTaskId },
      context: {},
      raisedBy: 'test',
      signature: `active:${failedTaskId}`,
      originTaskId: failedTaskId,
    })

    const summary = await reconcile.runStartupReconcile(makeDeps())

    const doneItem = await actionQueue.getActionQueueItem(doneItemId)
    const failedItem = await actionQueue.getActionQueueItem(failedItemId)

    expect(doneItem?.state).toBe('resolved')
    expect(failedItem?.state).toBe('open')
    expect(summary.staleActionQueueItemsResolved).toBeGreaterThanOrEqual(1)
  })

  it('is idempotent: a second reconcile pass after cleanup is a no-op', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const doneTaskId = 'T-done-idempotent'
    await insertTask(client, doneTaskId, 'done')
    await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: 'Stale alert',
      body: 'Should be resolved on first pass.',
      payload: { taskId: doneTaskId },
      context: {},
      raisedBy: 'test',
      signature: `idempotent:${doneTaskId}`,
      originTaskId: doneTaskId,
    })

    const first = await reconcile.runStartupReconcile(makeDeps())
    expect(first.staleActionQueueItemsResolved).toBeGreaterThanOrEqual(1)

    // Second pass: everything is already resolved — should be a no-op.
    const second = await reconcile.runStartupReconcile(makeDeps())
    expect(second.staleActionQueueItemsResolved).toBe(0)
  })
})
