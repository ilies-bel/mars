/**
 * Verifies that reconcileTerminalTasks drains:
 *   - Open action_queue_items whose origin_task_id is absent from tasks (purged tasks)
 *   - Orphaned action_queue_dismissals pointing at task ids not in tasks
 *
 * This is the "backfill cleanup" pass — pass (c) — added to cover historical
 * residue from tasks purged before the lifecycle-event plumbing existed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  initQueue: typeof import('../../queue').initQueue
  getClient: typeof import('../../queue').getClient
}

interface ActionQueueModule {
  initActionQueue: typeof import('../../lib/action-queue').initActionQueue
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
}

interface DismissalsModule {
  initActionQueueDismissals: typeof import('../../lib/action-queue-dismissals').initActionQueueDismissals
  dismissEntity: typeof import('../../lib/action-queue-dismissals').dismissEntity
}

interface ReconcileModule {
  reconcileTerminalTasks: typeof import('../lifecycle-reconcile').reconcileTerminalTasks
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-lifecycle-residue-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  await actionQueue.initActionQueue()
  const dismissals = (await import(
    '../../lib/action-queue-dismissals'
  )) as unknown as DismissalsModule
  await dismissals.initActionQueueDismissals()
  const reconcile = (await import('../lifecycle-reconcile')) as unknown as ReconcileModule
  return { q, actionQueue, dismissals, reconcile }
}

describe('reconcileTerminalTasks — purged-task residue (pass c)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('resolves 5 open rows whose origin_task_id is absent from tasks, and clears 13 orphan dismissals', async () => {
    const { q, actionQueue, dismissals, reconcile } = await loadModules(repo)
    const client = q.getClient()

    // Seed 5 open action_queue_items whose origin_task_id is NOT in tasks.
    const purgedIds: string[] = []
    const itemIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const purgedTaskId = `T-purged-${i}`
      purgedIds.push(purgedTaskId)
      const itemId = await actionQueue.raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: `Purged task ${purgedTaskId}`,
        body: 'orphan row',
        payload: {},
        context: {},
        raisedBy: 'test',
        signature: `sig-purged-${i}`,
        originTaskId: purgedTaskId,
      })
      itemIds.push(itemId)
    }

    // Seed 13 dismissals for task ids not in tasks.
    const dismissedIds: string[] = []
    for (let i = 0; i < 13; i++) {
      const ghostId = `T-ghost-${i}`
      dismissedIds.push(ghostId)
      await dismissals.dismissEntity('task', ghostId, { by: 'op' })
    }

    // --- RUN ---
    const { rowsResolved, dismissalsCleared } = await reconcile.reconcileTerminalTasks(client)

    // All 5 orphan open rows must be resolved.
    for (const itemId of itemIds) {
      const item = await actionQueue.getActionQueueItem(itemId)
      expect(item, `item ${itemId} should exist`).not.toBeNull()
      expect(item!.state, `item ${itemId} should be resolved`).toBe('resolved')
    }

    // All 13 orphan dismissals must be gone.
    for (const ghostId of dismissedIds) {
      const check = await client.execute({
        sql: `SELECT 1 FROM action_queue_dismissals
               WHERE entity_kind = 'task' AND entity_id = ? LIMIT 1`,
        args: [ghostId],
      })
      expect(check.rows, `dismissal for ${ghostId} should be gone`).toHaveLength(0)
    }

    // Return counts must cover the seeded rows.
    // rowsResolved includes pass (a) results (0 here) + pass (c) results (5 here).
    expect(rowsResolved).toBeGreaterThanOrEqual(5)
    // dismissalsCleared includes pass (b) results (13 here).
    expect(dismissalsCleared).toBeGreaterThanOrEqual(13)
  })

  it('is idempotent: running twice after cleanup produces zero counts on second run', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.getClient()

    // Seed one orphan row.
    await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: 'Purged task orphan',
      body: 'orphan',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: 'sig-orphan-idempotent',
      originTaskId: 'T-purged-idempotent',
    })

    const first = await reconcile.reconcileTerminalTasks(client)
    const second = await reconcile.reconcileTerminalTasks(client)

    expect(first.rowsResolved).toBeGreaterThanOrEqual(1)
    // Second pass finds nothing new.
    expect(second.rowsResolved).toBe(0)
    expect(second.dismissalsCleared).toBe(0)
  })
})
