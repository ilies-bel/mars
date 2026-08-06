/**
 * Regression test: mars drop --force must succeed for an origin+recovery pair
 * in either drop order, without hitting SQLITE_CONSTRAINT FK errors.
 *
 * Observed live 2026-07-03: dropping either the origin or the recovery task
 * of a pair (fix_for_task_id → origin, origin → recovery task_blockers edge)
 * threw "SQLITE_CONSTRAINT: FOREIGN KEY constraint failed". Root cause: the
 * drop cascade relied on ON DELETE CASCADE for task_acceptance,
 * task_claude_sessions, task_spec_files, task_done_criteria — tables whose
 * older schema (before the relevant CREATE TABLE IF NOT EXISTS was added)
 * lacked the CASCADE clause, leaving stale FK rows that blocked the DELETE.
 * Arc.drop() now explicitly deletes all child-table rows and nulls out
 * fix_for_task_id pointers before deleting any task row.
 *
 * Acceptance criteria (all four orderings must succeed without error):
 *   A. Drop recovery (fix) task → then verify origin can be dropped
 *   B. Drop origin → cascade also removes the fix task
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-drop-fk-regression-'))
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
 * Seed an origin+recovery pair directly in the DB, mirroring what the
 * orchestrator creates when a task fails and spawns a fix task:
 *   - origin task: status='failed'
 *   - fix task:    status='failed', fix_for_task_id=origin.id, kind='fix'
 *   - task_blockers edge: origin blocked by fix
 *   - self_heal_attempts row referencing the fix task
 *   - task_acceptance, task_claude_sessions, task_spec_files,
 *     task_done_criteria rows for BOTH tasks (the tables whose stale
 *     schemas triggered the FK error)
 */
const seedOriginAndFix = async (
  q: QueueMod,
  fixId: string,
): Promise<{ originId: string; fixId: string }> => {
  const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
  await q.updateTask(origin.id, { status: 'failed', error: 'test failure' })

  const c = q.resolveQueueClient()
  const isoNow = new Date().toISOString()
  const epochNow = Date.now()

  // Insert fix task (tasks.created_at / updated_at expect ISO-8601)
  await c.execute({
    sql: `INSERT INTO tasks
            (id, prompt, status, kind, fix_for_task_id, priority, intent, origin_id, created_at, updated_at)
          VALUES (?, ?, 'failed', 'fix', ?, 0, '', ?, ?, ?)`,
    args: [fixId, 'recovery fix task', origin.id, fixId, isoNow, isoNow],
  })

  // Origin is blocked by fix (origin→recovery task_blockers edge)
  // task_blockers.created_at expects epoch milliseconds (not ISO-8601)
  await c.execute({
    sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
    args: [origin.id, fixId, epochNow],
  })

  // self_heal_attempts ledger row (fix_task_id FK with ON DELETE CASCADE)
  // self_heal_attempts.created_at expects epoch milliseconds (not ISO-8601)
  await c.execute({
    sql: `INSERT INTO self_heal_attempts
            (parent_task_id, failure_signature, fix_task_id, created_at)
          VALUES (?, ?, ?, ?)`,
    args: [origin.id, 'sig-test', fixId, epochNow],
  })

  // Junction-table rows for origin — these are the tables whose missing CASCADE
  // caused the live FK error; insert for both tasks so the regression covers
  // both the cascade-delete path (origin drops fix) and the direct-drop path.
  const acOrigin = 'ac-origin-' + fixId
  const acFix = 'ac-fix-' + fixId
  // task_acceptance.updated_at is bigint (epoch milliseconds)
  await c.execute({
    sql: `INSERT INTO task_acceptance (id, task_id, position, text, updated_at)
          VALUES (?, ?, 0, 'criterion', ?)`,
    args: [acOrigin, origin.id, epochNow],
  })
  await c.execute({
    sql: `INSERT INTO task_acceptance (id, task_id, position, text, updated_at)
          VALUES (?, ?, 0, 'criterion', ?)`,
    args: [acFix, fixId, epochNow],
  })

  const csOrigin = 'cs-origin-' + fixId
  const csFix = 'cs-fix-' + fixId
  await c.execute({
    sql: `INSERT INTO task_claude_sessions (task_id, session_id, position) VALUES (?, ?, 0)`,
    args: [origin.id, csOrigin],
  })
  await c.execute({
    sql: `INSERT INTO task_claude_sessions (task_id, session_id, position) VALUES (?, ?, 0)`,
    args: [fixId, csFix],
  })

  await c.execute({
    sql: `INSERT INTO task_spec_files (task_id, path, position) VALUES (?, ?, 0)`,
    args: [origin.id, 'src/foo.ts'],
  })
  await c.execute({
    sql: `INSERT INTO task_spec_files (task_id, path, position) VALUES (?, ?, 0)`,
    args: [fixId, 'src/bar.ts'],
  })

  await c.execute({
    sql: `INSERT INTO task_done_criteria (task_id, criterion, position) VALUES (?, ?, 0)`,
    args: [origin.id, 'tests pass'],
  })
  await c.execute({
    sql: `INSERT INTO task_done_criteria (task_id, criterion, position) VALUES (?, ?, 0)`,
    args: [fixId, 'fix applied'],
  })

  return { originId: origin.id, fixId }
}

describe('drop origin+recovery pair — FK regression (ADR-0049 / ADR-0052)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it(
    '(A) dropping the recovery task then the origin succeeds without FK errors',
    async () => {
      const q = await loadQueue(repo)
      const { originId, fixId } = await seedOriginAndFix(q, 'fix-regr-aaa')

      // Drop the fix/recovery task first
      await expect(q.dropTask(fixId)).resolves.toMatchObject({
        taskId: fixId,
      })

      // Fix task must be gone
      expect(await q.getTask(fixId)).toBeNull()

      // Origin must still exist (not cascade-deleted)
      const origin = await q.getTask(originId)
      expect(origin).not.toBeNull()

      // Now drop the origin — must succeed even though fix_for_task_id pointed
      // at it (the FK was nulled by the fix-task drop)
      await expect(q.dropTask(originId)).resolves.toMatchObject({
        taskId: originId,
      })

      // Both gone
      expect(await q.getTask(originId)).toBeNull()
    },
    30_000, // vi.resetModules() + dynamic import + migrateQueueSchema() ~10s
  )

  it(
    '(B) dropping the origin cascades and removes the recovery task without FK errors',
    async () => {
      const q = await loadQueue(repo)
      const { originId, fixId } = await seedOriginAndFix(q, 'fix-regr-bbb')

      // Drop the origin — must cascade-delete the fix task
      const result = await q.dropTask(originId)
      expect(result.taskId).toBe(originId)
      expect(result.cascadedFixTaskIds).toContain(fixId)

      // Both must be gone
      expect(await q.getTask(originId)).toBeNull()
      expect(await q.getTask(fixId)).toBeNull()
    },
    30_000, // vi.resetModules() + dynamic import + migrateQueueSchema() ~10s
  )
})
