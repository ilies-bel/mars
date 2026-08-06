/**
 * Regression test: mars drop / mars purge must succeed when the target task
 * has task_progress rows.
 *
 * Observed live 2026-07-24: `mars drop mars-a20a63ee --force` and
 * `mars purge mars-a20a63ee` both aborted with:
 *   "update or delete on table \"tasks\" violates foreign key constraint
 *    \"task_progress_task_id_fkey\" on table \"task_progress\""
 * Root cause: Arc.drop() deleted every other child-table row before the
 * tasks DELETE, but never deleted task_progress rows, which hold a bare FK
 * (no ON DELETE CASCADE on older schemas).  The schema now adds CASCADE and
 * Arc.drop() now explicitly deletes task_progress rows as belt-and-suspenders.
 *
 * Acceptance criteria (all orderings must succeed without error):
 *   A. Drop a plain task that has task_progress rows → succeeds, rows removed.
 *   B. Drop origin → cascade also removes fix task (both have task_progress rows).
 *   C. Drop fix task first → then drop origin succeeds.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-drop-progress-fk-'))
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

/** Insert a task_progress row (note kind) for the given task id. */
const addProgressNote = async (
  q: QueueMod,
  taskId: string,
  suffix: string,
): Promise<void> => {
  const c = q.resolveQueueClient()
  const now = Date.now()
  await c.execute({
    sql: `INSERT INTO task_progress (id, task_id, created_at, author, kind, body)
          VALUES (?, ?, ?, 'coder', 'note', 'progress note')`,
    args: [`prog-${suffix}`, taskId, now],
  })
}

/**
 * Seed an origin+fix pair that both have task_progress rows.
 * Mirrors what the orchestrator creates when a task fails.
 */
const seedPairWithProgress = async (
  q: QueueMod,
  fixId: string,
): Promise<{ originId: string; fixId: string }> => {
  const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
  await q.updateTask(origin.id, { status: 'failed', error: 'test failure' })

  const c = q.resolveQueueClient()
  const isoNow = new Date().toISOString()
  const epochNow = Date.now()

  // tasks.created_at / updated_at expect ISO-8601
  await c.execute({
    sql: `INSERT INTO tasks
            (id, prompt, status, kind, fix_for_task_id, priority, intent, origin_id, created_at, updated_at)
          VALUES (?, ?, 'failed', 'fix', ?, 0, '', ?, ?, ?)`,
    args: [fixId, 'recovery fix task', origin.id, fixId, isoNow, isoNow],
  })

  // task_blockers.created_at expects epoch milliseconds (not ISO-8601)
  await c.execute({
    sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
    args: [origin.id, fixId, epochNow],
  })

  // task_progress rows for BOTH tasks — these are what triggered the live FK error
  await addProgressNote(q, origin.id, `origin-${fixId}`)
  await addProgressNote(q, fixId, `fix-${fixId}`)

  return { originId: origin.id, fixId }
}

// Use a single module load for all scenarios to avoid pglite WASM Abort on
// multiple vi.resetModules() cycles in the same process.
describe('drop task with task_progress rows — FK regression', () => {
  let repo: string
  let q: QueueMod

  beforeAll(async () => {
    repo = setupRepo()
    q = await loadQueue(repo)
  }, 30_000)

  afterAll(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('(A) dropping a plain task that has task_progress rows succeeds', async () => {
    const task = await q.enqueueTask('plain task', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'failed', error: 'test' })
    await addProgressNote(q, task.id, `plain-${task.id}`)

    // Must not throw FK violation
    await expect(q.dropTask(task.id)).resolves.toMatchObject({ taskId: task.id })
    expect(await q.getTask(task.id)).toBeNull()
  })

  it(
    '(B) dropping origin cascades fix task — both with task_progress rows — succeeds',
    async () => {
      const { originId, fixId } = await seedPairWithProgress(q, 'fix-cascade-bbb')

      const result = await q.dropTask(originId)
      expect(result.taskId).toBe(originId)
      expect(result.cascadedFixTaskIds).toContain(fixId)

      // Both rows gone — FK constraint satisfied
      expect(await q.getTask(originId)).toBeNull()
      expect(await q.getTask(fixId)).toBeNull()
    },
  )

  it(
    '(C) dropping fix task then origin — both with task_progress rows — succeeds',
    async () => {
      const { originId, fixId } = await seedPairWithProgress(q, 'fix-seq-ccc')

      // Drop fix first — must not hit FK on task_progress
      await expect(q.dropTask(fixId)).resolves.toMatchObject({ taskId: fixId })
      expect(await q.getTask(fixId)).toBeNull()

      // Origin must still exist
      expect(await q.getTask(originId)).not.toBeNull()

      // Now drop origin — must not hit FK on task_progress
      await expect(q.dropTask(originId)).resolves.toMatchObject({ taskId: originId })
      expect(await q.getTask(originId)).toBeNull()
    },
  )
})
