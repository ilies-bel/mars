/**
 * Regression test for mars-330d72e2: dropping a fix/rescue task that shares
 * its worktree_path and branch with a live origin must NOT remove the worktree
 * or delete the branch ref.
 *
 * The bug: a fix task stored the same `branch` and `worktree_path` as its
 * origin.  When the fix task was dropped (stale-recovery drop, operator drop,
 * or origin-succeeded path), `handleDrop` removed the shared worktree while
 * the origin's verify step was still running inside it.  The origin then went
 * `failed` with signature `unknown/unclassified` because its cwd was destroyed.
 *
 * The fix: `isWorktreeSharedWithLiveTask` is called before any
 * worktree/branch removal; it returns `true` when another non-terminal task
 * row references the same path or branch, and cleanup is skipped.
 *
 * Acceptance criteria (unit-level — filesystem operations are not invoked):
 *   (a) Returns `false` when no other task exists.
 *   (b) Returns `true` when the origin (non-terminal) shares the same
 *       worktree_path.
 *   (c) Returns `true` when only the branch is shared (no path match).
 *   (d) Returns `false` after the sharing task reaches a terminal status
 *       (done / failed / dropped).
 *   (e) Does NOT count the excluded task itself (self-exclusion works).
 *   (f) Exact bug scenario: origin in `verifying` + fix task sharing its
 *       worktree_path — the guard fires for the fix task's path/branch while
 *       the origin is live, and clears once the origin is done.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  enqueueTask: typeof import('../queue').enqueueTask
  updateTask: typeof import('../queue').updateTask
  resolveQueueClient: typeof import('../queue').resolveQueueClient
  isWorktreeSharedWithLiveTask: typeof import('../queue').isWorktreeSharedWithLiveTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-shared-worktree-guard-test-'))
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

/** Set a task's branch and worktree_path directly via SQL, bypassing lifecycle guards. */
const setWorktreeRef = async (
  q: QueueMod,
  taskId: string,
  branch: string,
  worktreePath: string | null,
): Promise<void> => {
  await q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET branch = ?, worktree_path = ? WHERE id = ?`,
    args: [branch, worktreePath, taskId],
  })
}

/** Set a task's status directly via SQL, bypassing lifecycle guards. */
const forceStatus = async (q: QueueMod, taskId: string, status: string): Promise<void> => {
  await q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET status = ? WHERE id = ?`,
    args: [status, taskId],
  })
}

const SHARED_PATH = '/fake/mars/worktrees/mars-caae60e2'
const SHARED_BRANCH = 'task/mars-caae60e2'

describe('isWorktreeSharedWithLiveTask', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('(a) returns false when no other task exists', async () => {
    const q = await loadQueue(repo)
    const task = await q.enqueueTask('solo task', undefined, { skipTriage: true })
    await setWorktreeRef(q, task.id, SHARED_BRANCH, SHARED_PATH)

    const shared = await q.isWorktreeSharedWithLiveTask(SHARED_PATH, SHARED_BRANCH, task.id)
    expect(shared).toBe(false)
  })

  it('(b) returns true when origin (non-terminal) shares the same worktree_path', async () => {
    const q = await loadQueue(repo)

    // Origin: non-terminal (running) with shared worktree+branch
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    await setWorktreeRef(q, origin.id, SHARED_BRANCH, SHARED_PATH)
    await forceStatus(q, origin.id, 'running')

    // Fix task with same worktree_path and branch
    const fixTask = await q.enqueueTask('fix task', undefined, { skipTriage: true })
    await setWorktreeRef(q, fixTask.id, SHARED_BRANCH, SHARED_PATH)

    // Checking from the fix task's perspective: origin is live → shared=true
    const shared = await q.isWorktreeSharedWithLiveTask(SHARED_PATH, SHARED_BRANCH, fixTask.id)
    expect(shared).toBe(true)
  })

  it('(c) returns true when only the branch is shared (no worktree_path match)', async () => {
    const q = await loadQueue(repo)

    // Origin: non-terminal, different path but same branch
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    await setWorktreeRef(q, origin.id, SHARED_BRANCH, '/different/path')
    await forceStatus(q, origin.id, 'verifying')

    // Fix task: its own path but same branch
    const fixTask = await q.enqueueTask('fix task', undefined, { skipTriage: true })
    await setWorktreeRef(q, fixTask.id, SHARED_BRANCH, SHARED_PATH)

    // Branch is shared → guard fires even without path overlap
    const shared = await q.isWorktreeSharedWithLiveTask(null, SHARED_BRANCH, fixTask.id)
    expect(shared).toBe(true)
  })

  it('(d) returns false after the sharing task reaches a terminal status (done)', async () => {
    const q = await loadQueue(repo)

    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    await setWorktreeRef(q, origin.id, SHARED_BRANCH, SHARED_PATH)
    await forceStatus(q, origin.id, 'running')

    const fixTask = await q.enqueueTask('fix task', undefined, { skipTriage: true })
    await setWorktreeRef(q, fixTask.id, SHARED_BRANCH, SHARED_PATH)

    // Origin is live → guard fires
    expect(
      await q.isWorktreeSharedWithLiveTask(SHARED_PATH, SHARED_BRANCH, fixTask.id),
    ).toBe(true)

    // done → terminal → guard clears
    await forceStatus(q, origin.id, 'done')
    expect(
      await q.isWorktreeSharedWithLiveTask(SHARED_PATH, SHARED_BRANCH, fixTask.id),
    ).toBe(false)
  })

  it('(d2) returns false after the sharing task reaches status=failed', async () => {
    const q = await loadQueue(repo)

    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    await setWorktreeRef(q, origin.id, SHARED_BRANCH, SHARED_PATH)
    await forceStatus(q, origin.id, 'running')

    const fixTask = await q.enqueueTask('fix task', undefined, { skipTriage: true })
    await setWorktreeRef(q, fixTask.id, SHARED_BRANCH, SHARED_PATH)

    expect(
      await q.isWorktreeSharedWithLiveTask(SHARED_PATH, SHARED_BRANCH, fixTask.id),
    ).toBe(true)

    await forceStatus(q, origin.id, 'failed')
    expect(
      await q.isWorktreeSharedWithLiveTask(SHARED_PATH, SHARED_BRANCH, fixTask.id),
    ).toBe(false)
  })

  it('(d3) returns false after the sharing task reaches status=dropped', async () => {
    const q = await loadQueue(repo)

    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    await setWorktreeRef(q, origin.id, SHARED_BRANCH, SHARED_PATH)
    await forceStatus(q, origin.id, 'running')

    const fixTask = await q.enqueueTask('fix task', undefined, { skipTriage: true })
    await setWorktreeRef(q, fixTask.id, SHARED_BRANCH, SHARED_PATH)

    expect(
      await q.isWorktreeSharedWithLiveTask(SHARED_PATH, SHARED_BRANCH, fixTask.id),
    ).toBe(true)

    await forceStatus(q, origin.id, 'dropped')
    expect(
      await q.isWorktreeSharedWithLiveTask(SHARED_PATH, SHARED_BRANCH, fixTask.id),
    ).toBe(false)
  })

  it('(e) does not count the excluded task itself (self-exclusion)', async () => {
    const q = await loadQueue(repo)

    // Single task: running, with worktree+branch set
    const task = await q.enqueueTask('task', undefined, { skipTriage: true })
    await setWorktreeRef(q, task.id, SHARED_BRANCH, SHARED_PATH)
    await forceStatus(q, task.id, 'running')

    // Excluding the task itself → no OTHER task shares → false
    const shared = await q.isWorktreeSharedWithLiveTask(SHARED_PATH, SHARED_BRANCH, task.id)
    expect(shared).toBe(false)
  })

  it('(f) exact bug: origin verifying + fix task sharing path → guard fires; clears after origin done', async () => {
    const q = await loadQueue(repo)
    const client = q.resolveQueueClient()

    // Origin task mars-caae60e2: verifying (non-terminal) with a known worktree+branch
    const origin = await q.enqueueTask('origin task mars-caae60e2', undefined, {
      skipTriage: true,
    })
    await setWorktreeRef(q, origin.id, SHARED_BRANCH, SHARED_PATH)
    await forceStatus(q, origin.id, 'verifying')

    // Fix task fix-da3c2425: same worktree+branch as origin (the bug scenario)
    const fixId = `fix-${origin.id.slice(0, 8)}`
    const now = new Date().toISOString()
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, kind, origin_id, branch, worktree_path, created_at, updated_at)
            VALUES (?, 'fix task', 'queued', ?, 'fix', ?, ?, ?, ?, ?)`,
      args: [fixId, origin.id, origin.id, SHARED_BRANCH, SHARED_PATH, now, now],
    })

    // The drop handler checks this before removing worktree/branch.
    // With origin still verifying, the guard must fire → cleanup is skipped.
    const sharedWhileLive = await q.isWorktreeSharedWithLiveTask(SHARED_PATH, SHARED_BRANCH, fixId)
    expect(sharedWhileLive).toBe(true)

    // Once the origin completes (done), the fix task's cleanup is safe.
    await forceStatus(q, origin.id, 'done')
    const sharedAfterDone = await q.isWorktreeSharedWithLiveTask(
      SHARED_PATH,
      SHARED_BRANCH,
      fixId,
    )
    expect(sharedAfterDone).toBe(false)
  })
})
