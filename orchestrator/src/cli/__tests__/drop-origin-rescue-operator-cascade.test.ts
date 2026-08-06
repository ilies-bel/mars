/**
 * Tests that `mars drop --force` on an origin task cascades BOTH its
 * fix-tasks (linked via fix_for_task_id) AND its rescue-operator tasks
 * (linked via origin_id, fix_for_task_id IS NULL).
 *
 * Regression guard for the bug where Arc.drop() only queried
 * `WHERE fix_for_task_id = ?`, leaving rescue-operators orphaned when
 * their origin was dropped (ADR-0049).
 *
 * Acceptance criteria:
 *   A. Dropping an origin cascades both its fix-task and its rescue-operator;
 *      no task row is left with an origin_id pointing at the deleted row.
 *   B. The origin itself does not appear in cascadedFixTaskIds.
 *   C. Exactly one task.dropped event is emitted for the origin (no duplicate
 *      from the self-referential origin_id guard).
 *   D. A done arc member (e.g. a done rescue-operator) is preserved (narrow
 *      cascade: done tasks represent completed history).
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-drop-rescue-cascade-'))
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
 * Seed an origin + fix-task + rescue-operator triple, mirroring what the
 * orchestrator creates when an arc has no automatic recovery left:
 *
 *   - origin task:        status='failed', origin_id=self
 *   - fix task:           status='failed', fix_for_task_id=origin.id,
 *                         origin_id=origin.id, kind='fix'
 *   - rescue-operator:    status='failed', fix_for_task_id=NULL,
 *                         origin_id=origin.id, kind='task',
 *                         tags_json='["rescue-operator"]'
 *   - task_blockers edge: origin blocked by fix
 */
const seedOriginFixAndRescue = async (
  q: QueueMod,
  fixId: string,
  rescueId: string,
): Promise<{ originId: string; fixId: string; rescueId: string }> => {
  const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
  await q.updateTask(origin.id, { status: 'failed', error: 'test failure' })

  const c = q.resolveQueueClient()
  // tasks.created_at / updated_at expect ISO-8601 strings
  const isoNow = new Date().toISOString()
  // task_blockers.created_at expects epoch milliseconds (integer)
  const epochNow = Date.now()

  // Insert fix task (kind='fix', fix_for_task_id=origin, origin_id=origin)
  await c.execute({
    sql: `INSERT INTO tasks
            (id, prompt, status, kind, fix_for_task_id, priority, intent, origin_id, created_at, updated_at)
          VALUES (?, ?, 'failed', 'fix', ?, 0, '', ?, ?, ?)`,
    args: [fixId, 'recovery fix task', origin.id, origin.id, isoNow, isoNow],
  })

  // Origin is blocked by fix task (origin→recovery task_blockers edge)
  // task_blockers.created_at expects epoch milliseconds (not ISO-8601)
  await c.execute({
    sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
    args: [origin.id, fixId, epochNow],
  })

  // Insert rescue-operator task (kind='task', fix_for_task_id=NULL, origin_id=origin)
  // Matches what rescue-operator-spawn.ts creates via store.enqueueTask with originId set.
  await c.execute({
    sql: `INSERT INTO tasks
            (id, prompt, status, kind, fix_for_task_id, priority, intent, origin_id,
             tags_json, created_at, updated_at)
          VALUES (?, ?, 'failed', 'task', NULL, 0, '', ?, ?, ?, ?)`,
    args: [
      rescueId,
      '[rescue-operator] Arc has dead-ended.',
      origin.id,
      JSON.stringify(['rescue-operator']),
      isoNow,
      isoNow,
    ],
  })

  return { originId: origin.id, fixId, rescueId }
}

describe('drop origin — rescue-operator cascade (ADR-0049)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it(
    '(A) dropping the origin cascades both its fix-task and its rescue-operator',
    async () => {
      const q = await loadQueue(repo)
      const { originId, fixId, rescueId } = await seedOriginFixAndRescue(
        q,
        'fix-rescue-aaa',
        'rescue-aaa',
      )

      const result = await q.dropTask(originId)

      // Origin is gone
      expect(await q.getTask(originId)).toBeNull()

      // Fix task is gone (cascaded via fix_for_task_id)
      expect(await q.getTask(fixId)).toBeNull()

      // Rescue-operator is gone (cascaded via origin_id)
      expect(await q.getTask(rescueId)).toBeNull()

      // Both appear in cascadedFixTaskIds
      expect(result.cascadedFixTaskIds).toContain(fixId)
      expect(result.cascadedFixTaskIds).toContain(rescueId)

      // No task row is left with origin_id pointing at the now-deleted origin
      const c = q.resolveQueueClient()
      const orphans = await c.execute({
        sql: `SELECT id FROM tasks WHERE origin_id = ? AND id != ?`,
        args: [originId, originId],
      })
      expect(orphans.rows).toHaveLength(0)
    },
    30_000,
  )

  it(
    '(B) the origin itself does not appear in cascadedFixTaskIds',
    async () => {
      const q = await loadQueue(repo)
      const { originId, fixId, rescueId } = await seedOriginFixAndRescue(
        q,
        'fix-rescue-bbb',
        'rescue-bbb',
      )

      const result = await q.dropTask(originId)

      expect(result.cascadedFixTaskIds).not.toContain(originId)
      expect(result.cascadedFixTaskIds).toContain(fixId)
      expect(result.cascadedFixTaskIds).toContain(rescueId)
    },
    30_000,
  )

  it(
    '(C) exactly one task.dropped event is emitted for the origin (no self-origin_id duplicate)',
    async () => {
      const q = await loadQueue(repo)
      const { originId } = await seedOriginFixAndRescue(
        q,
        'fix-rescue-ccc',
        'rescue-ccc',
      )

      await q.dropTask(originId)

      const c = q.resolveQueueClient()
      const rows = await c.execute({
        sql: `SELECT id FROM events WHERE type = 'task.dropped' AND payload::jsonb ->> 'taskId' = ?`,
        args: [originId],
      })
      expect(rows.rows).toHaveLength(1)
    },
    30_000,
  )

  it(
    '(D) a done rescue-operator is preserved by the narrow cascade',
    async () => {
      const q = await loadQueue(repo)
      const origin = await q.enqueueTask('origin task D', undefined, { skipTriage: true })
      await q.updateTask(origin.id, { status: 'failed', error: 'test failure' })

      const c = q.resolveQueueClient()
      const now = new Date().toISOString()
      const doneRescueId = 'rescue-done-ddd'

      // A done rescue-operator (status='done') — represents completed historical work
      await c.execute({
        sql: `INSERT INTO tasks
                (id, prompt, status, kind, fix_for_task_id, priority, intent, origin_id,
                 tags_json, created_at, updated_at)
              VALUES (?, ?, 'done', 'task', NULL, 0, '', ?, ?, ?, ?)`,
        args: [
          doneRescueId,
          '[rescue-operator] arc rescued',
          origin.id,
          JSON.stringify(['rescue-operator']),
          now,
          now,
        ],
      })

      await q.dropTask(origin.id)

      // Done rescue-operator is PRESERVED (narrow cascade skips done tasks)
      const doneRescue = await q.getTask(doneRescueId)
      expect(doneRescue).not.toBeNull()
      expect(doneRescue?.status).toBe('done')
    },
    30_000,
  )
})
