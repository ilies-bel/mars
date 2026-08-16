/**
 * Regression test: mars drop <origin> must succeed even when a recovery fix
 * task is already in status='dropped' (row still in the tasks table, but the
 * task was terminated via setTaskStatus rather than Arc.drop).
 *
 * Observed live 2026-08-16: mars drop <origin-id> --force failed with
 *   "update or delete on table "tasks" violates foreign key constraint
 *    "tasks_fix_for_task_id_fkey""
 * because fix-5611cce8 (status='dropped') still had fix_for_task_id pointing
 * at the origin.  The cascade query in Arc.drop() uses no status filter on the
 * fix_for_task_id branch, so the fix task IS found and included in
 * cascadedFixTaskIds — and the null-out at line ~2085 ensures the FK is
 * cleared before the origin DELETE.  This test pins both behaviours:
 *   1. cascadedFixTaskIds includes the already-dropped fix task
 *   2. dropTask(origin) completes without error and both rows are gone
 *
 * A "dropped" fix task arises when Arc.setTaskStatus(id, 'dropped') is called
 * (e.g. by the "arc-rescued", "superseded", or "origin-succeeded" paths) —
 * that path updates the tasks.status column but does NOT delete the row, so
 * the fix_for_task_id FK pointer survives until the origin is dropped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueMod {
  migrateQueueSchema: typeof import('../../core/queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../core/queue').resolveQueueClient
  enqueueTask: typeof import('../../core/queue').enqueueTask
  updateTask: typeof import('../../core/queue').updateTask
  dropTask: typeof import('../../core/queue').dropTask
  getTask: typeof import('../../core/queue').getTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-drop-fix-dropped-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string): Promise<QueueMod> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../../core/queue')
  await mod.migrateQueueSchema()
  return mod as unknown as QueueMod
}

/**
 * Seed an origin + fix task where the fix task is already in status='dropped'
 * (but still has its row in the tasks table with fix_for_task_id set).
 *
 * This mirrors what happens when Arc.setTaskStatus(fixId, 'dropped') is called
 * (arc-rescued / origin-succeeded paths) instead of Arc.drop(fixId):
 *   - The status column is set to 'dropped'
 *   - The fix_for_task_id column is NOT nulled out
 *   - The row is NOT deleted
 */
const seedOriginWithDroppedFixTask = async (
  q: QueueMod,
  fixId: string,
): Promise<{ originId: string; fixId: string }> => {
  const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
  await q.updateTask(origin.id, { status: 'failed', error: 'original failure' })

  const c = q.resolveQueueClient()
  const isoNow = new Date().toISOString()

  // Insert a fix task with status='dropped' and fix_for_task_id pointing at
  // the origin.  This is the exact state produced by setTaskStatus('dropped')
  // on a previously-created fix task — the row exists with a stale FK pointer.
  await c.execute({
    sql: `INSERT INTO tasks
            (id, prompt, status, kind, fix_for_task_id, priority, intent, origin_id, created_at, updated_at)
          VALUES (?, ?, 'dropped', 'fix', ?, 0, '', ?, ?, ?)`,
    args: [fixId, 'recovery fix task (dropped)', origin.id, fixId, isoNow, isoNow],
  })

  return { originId: origin.id, fixId }
}

describe('drop origin with already-dropped fix task — FK regression', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it(
    'dropTask(origin) succeeds and removes both rows when fix task status is already "dropped"',
    async () => {
      const q = await loadQueue(repo)
      const { originId, fixId } = await seedOriginWithDroppedFixTask(
        q,
        'fix-dropped-regr-aaa',
      )

      // Sanity: both rows exist before the drop
      expect(await q.getTask(originId)).not.toBeNull()
      expect(await q.getTask(fixId)).not.toBeNull()

      // Dropping the origin must succeed without FK constraint error and
      // must cascade-delete the already-dropped fix task.
      const result = await q.dropTask(originId)
      expect(result.taskId).toBe(originId)
      // The cascade must include the dropped fix task — even though its
      // status is terminal, its row (and FK pointer) still exists.
      expect(result.cascadedFixTaskIds).toContain(fixId)

      // Both rows must be gone.
      expect(await q.getTask(originId)).toBeNull()
      expect(await q.getTask(fixId)).toBeNull()

      // No leftover tasks.fix_for_task_id pointer to origin.
      const stale = await q.resolveQueueClient().execute({
        sql: `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id = ?`,
        args: [originId],
      })
      expect(
        Number((stale.rows[0] as unknown as { n: number | bigint }).n),
      ).toBe(0)
    },
    30_000,
  )
})
