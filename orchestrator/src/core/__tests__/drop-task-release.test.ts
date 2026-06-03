/**
 * Regression tests: purging a blocker task must not leave its dependents
 * permanently wedged in `blocked`.
 *
 * Acceptance criteria:
 *   (a) When the only blocker of D is purged via dropTask, D flips to
 *       'queued' and has no remaining task_blockers rows.
 *   (b) When D has two blockers (F and B) and only F is purged, D stays
 *       'blocked' because B is still active — dependent must not be
 *       released prematurely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  enqueueTask: typeof import('../queue').enqueueTask
  addBlockers: typeof import('../queue').addBlockers
  dropTask: typeof import('../queue').dropTask
  getTask: typeof import('../queue').getTask
  resolveQueueClient: typeof import('../queue').resolveQueueClient
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-drop-task-release-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string): Promise<QueueMod> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../queue')
  await mod.migrateQueueSchema()
  return mod as unknown as QueueMod
}

/** Set a task to 'blocked' and wire a blocker edge, bypassing auto-promote. */
const blockOn = async (q: QueueMod, taskId: string, blockerTaskId: string): Promise<void> => {
  await q.addBlockers(taskId, [blockerTaskId])
  await q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
    args: [taskId],
  })
}

const blockerRowCount = async (q: QueueMod, taskId: string): Promise<number> => {
  const r = await q.resolveQueueClient().execute({
    sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
    args: [taskId],
  })
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

describe('dropTask — dependent release', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('(a) releases a dependent to queued when its only blocker is purged', async () => {
    const q = await loadQueue(repo)

    const dependent = await q.enqueueTask('dependent task', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('fix task', undefined, { skipTriage: true })

    await blockOn(q, dependent.id, blocker.id)

    // Simulate the blocker having failed (e.g. a failed committer or fix task).
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [blocker.id],
    })

    // Purge the failed blocker.
    await q.dropTask(blocker.id)

    // The dependent must now be queued with no remaining blocker edges.
    const dep = await q.getTask(dependent.id)
    expect(dep?.status).toBe('queued')
    expect(await blockerRowCount(q, dependent.id)).toBe(0)
  })

  it('(b) leaves a dependent blocked when a second active blocker still exists', async () => {
    const q = await loadQueue(repo)

    const dependent = await q.enqueueTask('dependent task', undefined, { skipTriage: true })
    const blockerF = await q.enqueueTask('fix task F', undefined, { skipTriage: true })
    const blockerB = await q.enqueueTask('other blocker B', undefined, { skipTriage: true })

    // Block dependent on both F and B.
    await q.addBlockers(dependent.id, [blockerF.id, blockerB.id])
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [dependent.id],
    })

    // Mark F failed, leave B in its default (queued) status.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [blockerF.id],
    })

    // Purge the failed blocker F.
    await q.dropTask(blockerF.id)

    // Dependent must remain blocked because B is still active.
    const dep = await q.getTask(dependent.id)
    expect(dep?.status).toBe('blocked')

    // The edge to B must still be present.
    const remaining = await q.resolveQueueClient().execute({
      sql: `SELECT blocker_task_id FROM task_blockers WHERE task_id = ?`,
      args: [dependent.id],
    })
    const remainingBlockers = (remaining.rows as unknown as Array<{ blocker_task_id: string }>).map(
      (r) => r.blocker_task_id,
    )
    expect(remainingBlockers).toContain(blockerB.id)
    expect(remainingBlockers).not.toContain(blockerF.id)
  })
})
