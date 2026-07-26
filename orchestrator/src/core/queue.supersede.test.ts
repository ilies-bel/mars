/**
 * Integration tests for `enqueueTask` with `supersedes` option.
 *
 * Acceptance criteria verified:
 *   (a) Enqueueing with `--supersede <id>` produces a new task whose
 *       `origin_id` equals the superseded task's `origin_id` (or the
 *       superseded task's own id when it was an origin).
 *   (b) The new task's worktree is created on the superseded task's branch
 *       (`git worktree add <newPath> <supersededBranch>`), keyed by the new
 *       task's id in `.mars/worktrees/<newTaskId>/`.
 *   (c) The superseded task's `status` is `dropped` after the operation.
 *   (d) The superseded task's worktree registration is removed before the
 *       new worktree is created (never two live worktrees on the same branch).
 *   (e) Mid-way failure: if new-worktree creation fails after the old worktree
 *       was released, the superseded task remains `dropped`, no new task row is
 *       created, and the error surfaces with the branch name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueMod {
  migrateQueueSchema: typeof import('./queue').migrateQueueSchema
  enqueueTask: typeof import('./queue').enqueueTask
  getTask: typeof import('./queue').getTask
  listTasks: typeof import('./queue').listTasks
  resolveQueueClient: typeof import('./queue').resolveQueueClient
}

/** Create an isolated git repo with an initial commit and a `.mars/` dir. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-supersede-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  // Need at least one commit so `git worktree add ... HEAD` works.
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo })
  return repo
}

const loadQueue = async (repo: string): Promise<QueueMod> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('./queue')
  await mod.migrateQueueSchema()
  return mod as unknown as QueueMod
}

/**
 * Create a real git worktree for a task and stamp `branch`/`worktree_path`
 * on its DB row so the supersede path sees a live worktree registration.
 */
const provisionWorktree = async (
  q: QueueMod,
  repo: string,
  taskId: string,
): Promise<{ branch: string; worktreePath: string }> => {
  const branch = `task/${taskId}`
  mkdirSync(resolve(repo, '.mars', 'worktrees'), { recursive: true })
  const worktreePath = resolve(repo, '.mars', 'worktrees', taskId)
  execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, 'main'], { cwd: repo })
  await q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET branch = ?, worktree_path = ? WHERE id = ?`,
    args: [branch, worktreePath, taskId],
  })
  return { branch, worktreePath }
}

describe('queue.supersede', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── (a) + (b) + (c) + (d): Happy path ──────────────────────────────────

  it('happy path: new task inherits superseded origin_id, gets worktree on superseded branch', async () => {
    const q = await loadQueue(repo)

    // Create an origin task.
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })

    // Create a task that represents a failed recovery (lives under the same arc).
    const superseded = await q.enqueueTask('fix task — will be superseded', undefined, {
      skipTriage: true,
      originId: origin.id,
    })

    // Provision a real git worktree for the superseded task.
    const { branch } = await provisionWorktree(q, repo, superseded.id)

    // Supersede it — enqueue the rescue task.
    const newTask = await q.enqueueTask('rescue task', undefined, {
      skipTriage: true,
      supersedes: superseded.id,
    })

    // (a) New task inherits the superseded task's originId.
    expect(newTask.originId).toBe(origin.id)

    // (b) New task is on the superseded branch, keyed by new task id.
    expect(newTask.branch).toBe(branch)
    expect(newTask.worktreePath).toContain(newTask.id)
    expect(newTask.worktreePath).not.toContain(superseded.id)

    // (c) Superseded task is dropped.
    const dropped = await q.getTask(superseded.id)
    expect(dropped?.status).toBe('dropped')

    // (d) Superseded task's worktree registration was cleared.
    expect(dropped?.worktreePath).toBeNull()
  })

  it('superseding an origin task: new task gets the origin id as own originId', async () => {
    const q = await loadQueue(repo)

    // An origin task has originId === id.
    const originTask = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    expect(originTask.originId).toBe(originTask.id)

    await provisionWorktree(q, repo, originTask.id)

    const newTask = await q.enqueueTask('successor task', undefined, {
      skipTriage: true,
      supersedes: originTask.id,
    })

    // The new task inherits the origin's originId, which equals the origin's id.
    expect(newTask.originId).toBe(originTask.id)
  })

  it('new worktree exists at .mars/worktrees/<newTaskId> on disk', async () => {
    const q = await loadQueue(repo)
    const { statSync } = await import('node:fs')

    const superseded = await q.enqueueTask('task to supersede', undefined, { skipTriage: true })
    await provisionWorktree(q, repo, superseded.id)

    const newTask = await q.enqueueTask('successor', undefined, {
      skipTriage: true,
      supersedes: superseded.id,
    })

    // The new worktree directory must exist on disk.
    const expectedPath = resolve(repo, '.mars', 'worktrees', newTask.id)
    expect(newTask.worktreePath).toBe(expectedPath)
    expect(() => statSync(expectedPath)).not.toThrow()

    // The old worktree path must no longer be registered on the superseded row.
    const dropped = await q.getTask(superseded.id)
    expect(dropped?.worktreePath).toBeNull()
  })

  // ── (e): Mid-way failure path ───────────────────────────────────────────

  it('mid-way failure: superseded task stays dropped, no new row created, error names the branch', async () => {
    const q = await loadQueue(repo)

    // Create a task whose branch doesn't actually exist in git.
    // This forces `git worktree add` to fail.
    const superseded = await q.enqueueTask('will fail rescue', undefined, { skipTriage: true })
    const fakeBranch = 'task/nonexistent-branch-xyz'
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET branch = ? WHERE id = ?`,
      args: [fakeBranch, superseded.id],
    })

    // Attempt the supersede — must throw.
    let caughtError: Error | null = null
    try {
      await q.enqueueTask('replacement', undefined, {
        skipTriage: true,
        supersedes: superseded.id,
      })
    } catch (e) {
      caughtError = e as Error
    }

    expect(caughtError).not.toBeNull()

    // Error message must contain the branch name so the operator knows what to re-run.
    expect(caughtError!.message).toContain(fakeBranch)

    // Error message must suggest the retry incantation.
    expect(caughtError!.message).toContain('Re-run')

    // (e-i) Superseded task is dropped (step 2 completed before step 3 failed).
    const droppedTask = await q.getTask(superseded.id)
    expect(droppedTask?.status).toBe('dropped')

    // (e-ii) No new task row was created.
    const allTasks = await q.listTasks()
    const replacements = allTasks.filter((t) => t.prompt === 'replacement')
    expect(replacements).toHaveLength(0)
  })
})
