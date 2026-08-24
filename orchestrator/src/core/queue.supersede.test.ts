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
 *   (e) Mid-way failure: if new-worktree creation fails, the superseded task
 *       remains `failed` (atomicity guarantee — the origin drop and new task
 *       INSERT commit together; no partial drop is possible), no new task row
 *       is created, and the error surfaces with the branch name. A subsequent
 *       retry with --supersede <oldId> is therefore possible.
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

  it('mid-way failure: superseded task stays failed (atomic), no new row created, error names the branch', async () => {
    const q = await loadQueue(repo)

    // Create a task whose branch doesn't actually exist in git.
    // This forces `git worktree add` to fail during supersede.
    const superseded = await q.enqueueTask('will fail rescue', undefined, { skipTriage: true })
    const fakeBranch = 'task/nonexistent-branch-xyz'
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', error = 'timed out', branch = ? WHERE id = ?`,
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

    // (e-i) Atomicity guarantee: the origin drop only happens in the same
    // transaction as the new task INSERT. Since worktree creation failed before
    // the atomic block, the origin must remain 'failed' — not 'dropped'.
    // This preserves the ability to retry with --supersede <oldId>.
    const originAfter = await q.getTask(superseded.id)
    expect(originAfter?.status).toBe('failed')

    // (e-ii) No new task row was created.
    const allTasks = await q.listTasks()
    const replacements = allTasks.filter((t) => t.prompt === 'replacement')
    expect(replacements).toHaveLength(0)
  })

  // ── Salvage-checkpoint-tip briefing ─────────────────────────────────────
  //
  // A `--supersede` replacement inherits the superseded task's branch
  // verbatim. When that branch's tip is itself an orchestrator-authored
  // salvage checkpoint (the coder was killed mid-run with uncommitted
  // changes), the coder dispatched onto it otherwise has no signal that the
  // commit it's looking at is a "do not merge as-is" auto-commit rather than
  // real progress — and the merge step later refuses to fast-forward the
  // branch if the new coder just leaves another checkpoint on top. See the
  // incident writeup that spawned this task: three superseded tasks in a row
  // died without landing a real commit, tripping the signature-storm breaker.

  const salvageCheckpointMessage = async (): Promise<string> => {
    const { SALVAGE_CHECKPOINT_SUBJECT_PREFIX, SALVAGE_CHECKPOINT_TRAILER_KEY, SALVAGE_CHECKPOINT_TRAILER_VALUE } =
      await import('./lib/git/checkpoint')
    return `${SALVAGE_CHECKPOINT_SUBJECT_PREFIX} coder killed (exit 143) with 1 uncommitted path(s) — do not merge as-is\n\n${SALVAGE_CHECKPOINT_TRAILER_KEY}: ${SALVAGE_CHECKPOINT_TRAILER_VALUE}`
  }

  it('appends the salvage-tip brief to the new task prompt when the inherited branch tip is a checkpoint', async () => {
    const q = await loadQueue(repo)

    const superseded = await q.enqueueTask('will die mid-run', undefined, { skipTriage: true })
    const { worktreePath } = await provisionWorktree(q, repo, superseded.id)
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', await salvageCheckpointMessage()], {
      cwd: worktreePath,
    })

    const newTask = await q.enqueueTask('finish the work', undefined, {
      skipTriage: true,
      supersedes: superseded.id,
    })

    expect(newTask.prompt).toContain('finish the work')
    expect(newTask.prompt).toContain('## Inherited salvage checkpoint')
    expect(newTask.prompt).toContain(`mars task add --blocked-by ${newTask.id}`)
  })

  it('does NOT append the salvage-tip brief when the inherited branch tip is a real commit', async () => {
    const q = await loadQueue(repo)

    const superseded = await q.enqueueTask('normal failed task', undefined, { skipTriage: true })
    const { worktreePath } = await provisionWorktree(q, repo, superseded.id)
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'feat: ordinary real work'], {
      cwd: worktreePath,
    })

    const newTask = await q.enqueueTask('continue the work', undefined, {
      skipTriage: true,
      supersedes: superseded.id,
    })

    expect(newTask.prompt).toBe('continue the work')
    expect(newTask.prompt).not.toContain('Inherited salvage checkpoint')
  })
})
