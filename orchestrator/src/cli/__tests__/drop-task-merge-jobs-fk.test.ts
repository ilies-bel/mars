/**
 * Regression test: mars drop must succeed when the target task has merge_jobs rows.
 *
 * Observed live: `mars drop <id> --force` aborted with:
 *   "update or delete on table \"tasks\" violates foreign key constraint
 *    \"merge_jobs_task_id_fkey\" on table \"merge_jobs\""
 * Root cause: Arc.drop() never deleted merge_jobs rows before the tasks DELETE,
 * and merge_jobs.task_id has no ON DELETE CASCADE. Any task that reached the
 * merge stage was undeletable.
 *
 * Acceptance criteria:
 *   A. Drop a task that has a merge_jobs row → succeeds, row removed,
 *      mergeJobsDeleted=1 reported.
 *   B. Drop an origin whose fix task ALSO has a merge_jobs row → both rows
 *      removed, mergeJobsDeleted=2 reported.
 *   C. Drop a task with no merge_jobs rows → still succeeds,
 *      mergeJobsDeleted=0 reported.
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-drop-merge-jobs-fk-'))
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

/** Insert a merge_jobs row for the given task_id (simulates a task that reached merge). */
const addMergeJob = async (q: QueueMod, taskId: string): Promise<string> => {
  const { randomUUID } = await import('node:crypto')
  const id = randomUUID()
  await q.resolveQueueClient().execute({
    sql: `INSERT INTO merge_jobs
            (id, task_id, status, attempts, integration_branch, worktree_path, branch)
          VALUES (?, ?, 'done', 1, 'main', '/tmp/wt', ?)`,
    args: [id, taskId, `task/${taskId}`],
  })
  return id
}

/** Count merge_jobs rows for a given task_id. */
const countMergeJobs = async (q: QueueMod, taskId: string): Promise<number> => {
  const rs = await q.resolveQueueClient().execute({
    sql: `SELECT COUNT(*) AS n FROM merge_jobs WHERE task_id = ?`,
    args: [taskId],
  })
  return Number((rs.rows[0] as unknown as { n: number | bigint }).n)
}

// Use a single module load for all scenarios to avoid pglite WASM Abort on
// multiple vi.resetModules() cycles in the same process.
describe('drop task with merge_jobs rows — FK regression', () => {
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

  it('(A) dropping a task with a merge_jobs row succeeds and reports mergeJobsDeleted=1', async () => {
    const task = await q.enqueueTask('task-with-merge-job', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'done' })
    await addMergeJob(q, task.id)

    // Must not throw FK violation
    const result = await q.dropTask(task.id)

    expect(result.taskId).toBe(task.id)
    expect(result.mergeJobsDeleted).toBe(1)

    // Task row gone
    expect(await q.getTask(task.id)).toBeNull()

    // merge_jobs row gone
    expect(await countMergeJobs(q, task.id)).toBe(0)
  })

  it(
    '(B) dropping origin cascades fix task — both with merge_jobs rows — mergeJobsDeleted=2',
    async () => {
      const origin = await q.enqueueTask('origin-with-merge-job', undefined, { skipTriage: true })
      await q.updateTask(origin.id, { status: 'failed', error: 'test' })

      const c = q.resolveQueueClient()
      const isoNow = new Date().toISOString()
      const epochNow = Date.now()
      const fixId = 'fix-merge-jobs-bbb'
      // tasks.created_at / updated_at expect ISO-8601
      await c.execute({
        sql: `INSERT INTO tasks
                (id, prompt, status, kind, fix_for_task_id, priority, intent, origin_id, created_at, updated_at)
              VALUES (?, ?, 'done', 'fix', ?, 0, '', ?, ?, ?)`,
        args: [fixId, 'recovery fix task', origin.id, fixId, isoNow, isoNow],
      })
      // task_blockers.created_at expects epoch milliseconds (not ISO-8601)
      await c.execute({
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
        args: [origin.id, fixId, epochNow],
      })

      // Both tasks have merge_jobs rows
      await addMergeJob(q, origin.id)
      await addMergeJob(q, fixId)

      const result = await q.dropTask(origin.id)

      expect(result.taskId).toBe(origin.id)
      expect(result.cascadedFixTaskIds).toContain(fixId)
      expect(result.mergeJobsDeleted).toBe(2)

      // Both task rows gone
      expect(await q.getTask(origin.id)).toBeNull()
      expect(await q.getTask(fixId)).toBeNull()

      // Both merge_jobs rows gone
      expect(await countMergeJobs(q, origin.id)).toBe(0)
      expect(await countMergeJobs(q, fixId)).toBe(0)
    },
  )

  it('(C) dropping a task with no merge_jobs rows succeeds and reports mergeJobsDeleted=0', async () => {
    const task = await q.enqueueTask('task-no-merge-job', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'done' })

    const result = await q.dropTask(task.id)

    expect(result.taskId).toBe(task.id)
    expect(result.mergeJobsDeleted).toBe(0)
    expect(await q.getTask(task.id)).toBeNull()
  })
})
