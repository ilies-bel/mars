/**
 * Verifies that reconcileTerminalTasks drains open action_queue_items whose
 * origin_task_id is absent from tasks (purged tasks).
 *
 * This is the "backfill cleanup" pass — added to cover historical residue
 * from tasks purged before the lifecycle-event plumbing existed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-lifecycle-residue-test-'))
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
  const reconcile = (await import('../lifecycle-reconcile')) as unknown as ReconcileModule
  return { q, actionQueue, reconcile }
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

  it('resolves 5 open rows whose origin_task_id is absent from tasks', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed 5 open action_queue_items whose origin_task_id is NOT in tasks.
    const itemIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const purgedTaskId = `T-purged-${i}`
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

    // --- RUN ---
    const { rowsResolved } = await reconcile.reconcileTerminalTasks(client)

    // All 5 orphan open rows must be resolved.
    for (const itemId of itemIds) {
      const item = await actionQueue.getActionQueueItem(itemId)
      expect(item, `item ${itemId} should exist`).not.toBeNull()
      expect(item!.state, `item ${itemId} should be resolved`).toBe('resolved')
    }

    // Return counts must cover the seeded rows.
    expect(rowsResolved).toBeGreaterThanOrEqual(5)
  })

  it('is idempotent: running twice after cleanup produces zero counts on second run', async () => {
    const { q, actionQueue, reconcile } = await loadModules(repo)
    const client = q.resolveQueueClient()

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
  })
})
