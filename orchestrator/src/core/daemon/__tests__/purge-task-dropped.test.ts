/**
 * Tests for purging tasks in the `dropped` terminal state.
 *
 * `dropped` is a terminal status (like `failed` and `done`), but the previous
 * guard in corePurgeTask only allowed purging `failed` and `done` tasks,
 * causing dropped tasks to become permanently stranded — neither purgeable nor
 * restartable. This regression test asserts the fix: a dropped task must be
 * purgeable, with the same commit-ahead / --force semantics as failed/done.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  updateTask: typeof import('../../queue').updateTask
}

interface PurgeTaskModule {
  corePurgeTask: typeof import('../purge-task').corePurgeTask
  PurgeAheadError: typeof import('../purge-task').PurgeAheadError
}

/** Create a temp git repo with a configured identity so commits work. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-purge-dropped-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  // Create an initial commit on main so the integration branch exists.
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return repo
}

/**
 * Create a branch with one unique commit (not reachable from 'main').
 * Returns the branch name.
 */
const makeBranchWithCommit = (repo: string, branch: string): string => {
  execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
  writeFileSync(resolve(repo, 'work.txt'), `work on ${branch}\n`)
  execFileSync('git', ['add', 'work.txt'], { cwd: repo })
  execFileSync('git', ['commit', '-m', `feat: work on ${branch}`], { cwd: repo })
  execFileSync('git', ['checkout', 'main'], { cwd: repo })
  return branch
}

/** Returns true if a local branch exists in the repo. */
const branchExists = (repo: string, branch: string): boolean => {
  try {
    execSync(`git rev-parse --verify refs/heads/${branch}`, {
      cwd: repo,
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; pt: PurgeTaskModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const pt = (await import('../purge-task')) as unknown as PurgeTaskModule
  return { q, pt }
}

describe('corePurgeTask — dropped terminal status', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet: dropped task without unique commits purges cleanly ──────

  it('purges a dropped task with no unique commits (force=false)', async () => {
    const { q, pt } = await loadModules(repo)

    const task = await q.enqueueTask('superseded work', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'dropped', failureReason: 'superseded' })

    // Create a branch that points at the same commit as main (no unique commits).
    const branch = `task/${task.id}`
    execFileSync('git', ['branch', branch], { cwd: repo })

    // Without --force, purge must succeed (no unique commits ahead).
    await expect(
      pt.corePurgeTask(task.id, false, 'main', repo),
    ).resolves.toMatchObject({ taskId: task.id })

    // Row is gone.
    expect(await q.getTask(task.id)).toBeNull()
    // Branch is gone.
    expect(branchExists(repo, branch)).toBe(false)
  })

  // ── dropped + unique commits: --force required ────────────────────────────

  it('refuses a dropped task whose branch has unique commits without --force', async () => {
    const { q, pt } = await loadModules(repo)

    const task = await q.enqueueTask('dropped but has commits', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'dropped', failureReason: 'superseded' })

    const branch = `task/${task.id}`
    makeBranchWithCommit(repo, branch)

    // Without --force, must throw PurgeAheadError.
    await expect(
      pt.corePurgeTask(task.id, false, 'main', repo),
    ).rejects.toBeInstanceOf(pt.PurgeAheadError)

    // Row and branch survive the refusal.
    expect(await q.getTask(task.id)).not.toBeNull()
    expect(branchExists(repo, branch)).toBe(true)
  })

  it('purges a dropped task with unique commits when --force is passed', async () => {
    const { q, pt } = await loadModules(repo)

    const task = await q.enqueueTask('dropped with commits', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'dropped', failureReason: 'superseded' })

    const branch = `task/${task.id}`
    makeBranchWithCommit(repo, branch)

    // With --force, purge must succeed even with unique commits.
    await expect(
      pt.corePurgeTask(task.id, true, 'main', repo),
    ).resolves.toMatchObject({ taskId: task.id })

    // Row is gone.
    expect(await q.getTask(task.id)).toBeNull()
    // Branch is gone.
    expect(branchExists(repo, branch)).toBe(false)
  })

  // ── queued (in-flight) remains blocked ────────────────────────────────────

  it('still refuses an in-flight (queued) task', async () => {
    const { q, pt } = await loadModules(repo)

    const task = await q.enqueueTask('queued work', undefined, {
      skipTriage: true,
    })
    // Leave in queued status — not a terminal state.

    await expect(
      pt.corePurgeTask(task.id, true, 'main', repo),
    ).rejects.toThrow('refuse to purge in-flight tasks')

    // Row survives.
    expect(await q.getTask(task.id)).not.toBeNull()
  })
})
