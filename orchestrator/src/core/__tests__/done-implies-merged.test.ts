/**
 * Done-implies-merged invariant (ADR-0052).
 *
 * When a task transitions to 'done' and its `branch` column is set, the Arc
 * funnel asserts the branch has 0 commits ahead of the integration branch.
 * A non-zero count is the fingerprint of the "committer false-done" bug class
 * (fixed in 3d7cb3c2 for mars-984de140): the task claims done but the merge
 * step never ran.
 *
 * On violation the transition is redirected: the task is set to 'failed' with
 * `failure_reason_code='done-with-unmerged-commits'` and an action-queue item
 * of the same kind is raised.
 *
 * Skip conditions (check is a no-op):
 *   – branch column is NULL (task never had a worktree).
 *   – `git rev-list` exits non-zero (branch was deleted after the merge step;
 *     normal post-merge cleanup ordering where branch deletion precedes the
 *     status write). Treat as 0 commits ahead → allow done.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../queue').resolveQueueClient
  enqueueTask: typeof import('../queue').enqueueTask
  updateTask: typeof import('../queue').updateTask
  getTask: typeof import('../queue').getTask
}

interface ActionQueueMod {
  listActionQueueItems: typeof import('../lib/action-queue').listActionQueueItems
}

// Sets up a temporary git repo with a single commit on main.
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-done-implies-merged-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  // Need at least one commit so git rev-list has a base.
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

// Creates a branch with one empty commit ahead of main (unmerged).
const makeUnmergedBranch = (repo: string, branch: string): void => {
  execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'wip'], { cwd: repo })
  execFileSync('git', ['checkout', 'main'], { cwd: repo })
}

// Creates a branch that is at the same HEAD as main (0 commits ahead = merged).
const makeMergedBranch = (repo: string, branch: string): void => {
  execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
  execFileSync('git', ['checkout', 'main'], { cwd: repo })
}

const loadMods = async (repo: string): Promise<{ q: QueueMod; aq: ActionQueueMod }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = await import('../queue')
  await queue.migrateQueueSchema()
  const aq = await import('../lib/action-queue')
  return {
    q: queue as unknown as QueueMod,
    aq: aq as unknown as ActionQueueMod,
  }
}

describe('done-implies-merged guard (ADR-0052)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('redirects a done transition to failed when the branch has commits ahead of integration', async () => {
    const { q, aq } = await loadMods(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    // Set the task's branch to a branch that has unmerged commits.
    const branch = `task/${task.id}`
    makeUnmergedBranch(repo, branch)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET branch = ?, status = 'verifying' WHERE id = ?`,
      args: [branch, task.id],
    })

    // Attempting a done transition should be intercepted.
    await q.updateTask(task.id, { status: 'done' })

    const fetched = await q.getTask(task.id)
    expect(fetched?.status).toBe('failed')
    expect(fetched?.failureReasonCode).toBe('done-with-unmerged-commits')
  })

  it('raises a done-with-unmerged-commits action-queue item on violation', async () => {
    const { q, aq } = await loadMods(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    const branch = `task/${task.id}`
    makeUnmergedBranch(repo, branch)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET branch = ?, status = 'verifying' WHERE id = ?`,
      args: [branch, task.id],
    })

    await q.updateTask(task.id, { status: 'done' })

    const items = await aq.listActionQueueItems()
    const item = items.find((i) => i.kind === 'done-with-unmerged-commits')
    expect(item).toBeDefined()
    expect(item?.payload).toMatchObject({ taskId: task.id, branch })
  })

  it('allows done when branch is at 0 commits ahead (already merged)', async () => {
    const { q } = await loadMods(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    const branch = `task/${task.id}`
    makeMergedBranch(repo, branch)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET branch = ?, status = 'verifying' WHERE id = ?`,
      args: [branch, task.id],
    })

    await q.updateTask(task.id, { status: 'done' })

    const fetched = await q.getTask(task.id)
    expect(fetched?.status).toBe('done')
  })

  it('allows done when branch column is NULL (no worktree assigned)', async () => {
    const { q } = await loadMods(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    // Branch is NULL by default for a newly enqueued task.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying' WHERE id = ?`,
      args: [task.id],
    })

    await q.updateTask(task.id, { status: 'done' })

    const fetched = await q.getTask(task.id)
    expect(fetched?.status).toBe('done')
  })

  it('allows done when the branch has been deleted after merge (git error → treat as 0 ahead)', async () => {
    const { q } = await loadMods(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    // Set the branch to a name that does NOT exist in the repo.
    const branch = `task/${task.id}`
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET branch = ?, status = 'verifying' WHERE id = ?`,
      args: [branch, task.id],
    })

    // Branch does not exist → git rev-list fails → treat as 0 ahead → allow done.
    await q.updateTask(task.id, { status: 'done' })

    const fetched = await q.getTask(task.id)
    expect(fetched?.status).toBe('done')
  })
})
