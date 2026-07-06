/**
 * Regression test: coreRestartTask must NOT delete a branch whose tip is
 * ahead of the integration branch. Commits ahead = work product that must
 * not be silently discarded.
 *
 * Covers the incident (2026-07-06 ~23:52Z, origin mars-50e3b511 /
 * recovery fix-a2b92b18) where `mars restart fix-a2b92b18` deleted
 * task/mars-50e3b511 because the fix task stored the origin's branch in its
 * own `branch` column, and the old cleanup path deleted it unconditionally.
 *
 * The invariant: NO cleanup path may delete a task branch whose tip is not an
 * ancestor of the integration branch. Delete the worktree if needed, but the
 * ref must survive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { InMemoryStore } from '@mars/workflow'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface RestartModule {
  coreRestartTask: typeof import('../restart-task').coreRestartTask
}

/** Create a minimal git repo with one commit on main so listUniqueCommitsAhead has a base. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-restart-ahead-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repo })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; restart: RestartModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const restart = (await import('../restart-task')) as unknown as RestartModule
  return { q, restart }
}

const branchExists = (repo: string, branch: string): boolean =>
  execFileSync('git', ['branch', '--list', branch], { cwd: repo }).toString().trim() !== ''

describe('coreRestartTask — commits-ahead guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.INTEGRATION_BRANCH
    rmSync(repo, { recursive: true, force: true })
  })

  it('preserves a branch with commits ahead of integration when restarted', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    // Create the task branch and land a commit ahead of main
    execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
    writeFileSync(resolve(repo, 'work.txt'), 'work product')
    execFileSync('git', ['add', 'work.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'work commit — must survive restart'], { cwd: repo })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    // Mark the task as failed with the branch column populated
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ? WHERE id = ?`,
      args: [branch, task.id],
    })

    // Restart must NOT delete the branch — it carries unmerged work
    await restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore())

    expect(branchExists(repo, branch)).toBe(true)
  })

  it('simulates the incident: fix task storing origin branch, restart preserves the origin ref', async () => {
    // The real incident: fix-a2b92b18 stored task/mars-50e3b511 in its own
    // branch column because it took over the origin's worktree. When
    // `mars restart fix-a2b92b18` was called, it deleted task/mars-50e3b511.
    const { q, restart } = await loadModules(repo)

    // Simulate the origin task's branch with committed work
    const originTask = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    const originBranch = `task/${originTask.id}`

    execFileSync('git', ['checkout', '-b', originBranch], { cwd: repo })
    writeFileSync(resolve(repo, 'origin-work.txt'), '4 commits worth of work')
    execFileSync('git', ['add', 'origin-work.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'origin: unmerged committed work'], { cwd: repo })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    // Simulate the fix task that stored the origin's branch in its row
    const fixTask = await q.enqueueTask('fix for origin', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', fix_for_task_id = ?, branch = ? WHERE id = ?`,
      args: [originTask.id, originBranch, fixTask.id],
    })

    // `mars restart fix-a2b92b18` — must NOT delete task/mars-50e3b511
    await restart.coreRestartTask(fixTask.id, new Set(['failed']), new InMemoryStore())

    expect(branchExists(repo, originBranch)).toBe(true)
  })

  it('deletes the branch when it has no commits ahead of integration', async () => {
    const { q, restart } = await loadModules(repo)

    const task = await q.enqueueTask('task at integration tip', undefined, { skipTriage: true })
    const branch = `task/${task.id}`

    // Branch at the same tip as main — zero commits ahead, no work product
    execFileSync('git', ['branch', branch], { cwd: repo })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', branch = ? WHERE id = ?`,
      args: [branch, task.id],
    })

    await restart.coreRestartTask(task.id, new Set(['failed']), new InMemoryStore())

    // No unmerged work — the branch should be cleaned up
    expect(branchExists(repo, branch)).toBe(false)
  })
})
