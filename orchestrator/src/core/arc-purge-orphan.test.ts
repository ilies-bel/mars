import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('./queue').enqueueTask
  addBlockers: typeof import('./queue').addBlockers
  getTask: typeof import('./queue').getTask
  resolveQueueClient: typeof import('./queue').resolveQueueClient
  ensureQueueSchema: typeof import('./queue').ensureQueueSchema
}

interface ArcModule {
  Arc: typeof import('./arc').Arc
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('./lib/action-queue').listActionQueueItems
}

interface BlockerResolutionModule {
  ORPHANED_ORIGIN_FAILURE_REASON: typeof import('./blocker-resolution').ORPHANED_ORIGIN_FAILURE_REASON
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-purge-orphan-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; arc: ArcModule; actionQueue: ActionQueueModule; br: BlockerResolutionModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('./queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  const arc = (await import('./arc')) as unknown as ArcModule
  const actionQueue = (await import('./lib/action-queue')) as unknown as ActionQueueModule
  const br = (await import('./blocker-resolution')) as unknown as BlockerResolutionModule
  return { q, arc, actionQueue, br }
}

const blockTask = async (
  q: QueueModule,
  taskId: string,
  blockerTaskId: string,
  recoverySpawnedCount = 0,
): Promise<void> => {
  await q.addBlockers(taskId, [blockerTaskId])
  await q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET status = 'blocked', recovery_spawned_count = ? WHERE id = ?`,
    args: [recoverySpawnedCount, taskId],
  })
}

describe('Arc.drop — purge cascade orphan guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('fails a blocked dependent whose origin_id === purged task, raises one action-queue item, and no task.unblocked fires on subsequent blocker completion', async () => {
    // Scenario:
    //   P  — task to be purged; D's origin
    //   D  — dependent with origin_id = P.id, blocked on P and B
    //   B  — a second blocker that survives the purge
    //
    // Step 1: drop(P) → D must be failed (ORPHANED_ORIGIN), not queued.
    // Step 2: B completes + unblockByCompletion runs → no task.unblocked for D.

    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, arc, actionQueue, br } = await loadModules(repo)

    // Create P (origin of D) and B (second blocker).
    const P = await q.enqueueTask('origin task to purge', undefined, { skipTriage: true })
    const B = await q.enqueueTask('surviving blocker', undefined, { skipTriage: true })
    // D has origin_id = P.id and is blocked on both P and B.
    const D = await q.enqueueTask('dependent task', undefined, {
      skipTriage: true,
      originId: P.id,
    })
    await blockTask(q, D.id, P.id, 0)
    // Also block D on B (so B's later completion drives unblockByCompletion).
    await q.addBlockers(D.id, [B.id])

    // Sanity: D is blocked.
    expect((await q.getTask(D.id))?.status).toBe('blocked')

    // ── Step 1: purge P ──────────────────────────────────────────────────────
    const { Arc } = arc
    await Arc.load(P.id).drop()

    // P is gone.
    expect(await q.getTask(P.id)).toBeNull()

    // D must be failed, not queued.
    const afterDrop = await q.getTask(D.id)
    expect(afterDrop?.status).toBe('failed')
    expect(afterDrop?.failureReason).toBe(br.ORPHANED_ORIGIN_FAILURE_REASON)

    // Exactly one action-queue item naming D and P must be open.
    const open = await actionQueue.listActionQueueItems('open')
    const orphanItems = open.filter(
      (i) =>
        i.kind === 'orphaned-origin' &&
        (i.payload as Record<string, unknown>).taskId === D.id &&
        (i.payload as Record<string, unknown>).originId === P.id,
    )
    expect(orphanItems).toHaveLength(1)

    // No task.unblocked event for D must exist after the drop.
    const eventsAfterDrop = await q.resolveQueueClient().execute({
      sql: `SELECT payload FROM events WHERE type = 'task.unblocked'`,
      args: [],
    })
    const unblockedForDAfterDrop = eventsAfterDrop.rows.filter((row) => {
      try {
        const p = JSON.parse((row as Record<string, unknown>).payload as string) as {
          taskId: string
        }
        return p.taskId === D.id
      } catch {
        return false
      }
    })
    expect(unblockedForDAfterDrop).toHaveLength(0)

    // ── Step 2: B completes — task.unblocked must NOT fire for D ─────────────
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [B.id],
    })
    await Arc.unblockByCompletion(B.id)

    // D must still be failed (not re-queued by unblockByCompletion).
    const afterBComplete = await q.getTask(D.id)
    expect(afterBComplete?.status).toBe('failed')

    // Still no task.unblocked for D.
    const eventsAfterB = await q.resolveQueueClient().execute({
      sql: `SELECT payload FROM events WHERE type = 'task.unblocked'`,
      args: [],
    })
    const unblockedForDAfterB = eventsAfterB.rows.filter((row) => {
      try {
        const p = JSON.parse((row as Record<string, unknown>).payload as string) as {
          taskId: string
        }
        return p.taskId === D.id
      } catch {
        return false
      }
    })
    expect(unblockedForDAfterB).toHaveLength(0)

    // The action-queue item count must remain exactly one (no duplicate raised).
    const openAfterB = await actionQueue.listActionQueueItems('open')
    const orphanItemsAfterB = openAfterB.filter(
      (i) =>
        i.kind === 'orphaned-origin' &&
        (i.payload as Record<string, unknown>).taskId === D.id,
    )
    expect(orphanItemsAfterB).toHaveLength(1)
  })

  it('does not fail a self-origin dependent when its origin task is purged by a different purge', async () => {
    // Regression guard: a self-origin task (origin_id === id) blocked on P
    // is NOT orphaned when P is dropped. P is not its origin — it is its own
    // arc root. It must be re-queued normally once P (its only blocker) drops.

    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, arc } = await loadModules(repo)

    const P = await q.enqueueTask('task to purge', undefined, { skipTriage: true })
    // D has default origin_id = D.id (self-origin), blocked only on P.
    const D = await q.enqueueTask('self-origin dependent', undefined, { skipTriage: true })
    await blockTask(q, D.id, P.id, 0)

    await arc.Arc.load(P.id).drop()

    // D's own origin exists (itself), so it must be re-queued, not failed.
    const reloaded = await q.getTask(D.id)
    expect(reloaded?.status).toBe('queued')
  })
})
