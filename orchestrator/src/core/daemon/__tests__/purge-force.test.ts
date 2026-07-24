/**
 * Tests for purge --force flag (slice 2/4 of PRD 11b78226).
 *
 * corePurgeTask(id, force, integrationBranch, repoRoot) is the extracted
 * core used by the UDS handler (handlePurge in server.ts).
 *
 * Acceptance criteria exercised here:
 *   - With force=true, purge proceeds even when the branch has unique commits:
 *     the worktree directory is removed, the branch is deleted, and the row
 *     is dropped from the queue.
 *   - Without force=true, purge refuses when the branch has unique commits:
 *     throws PurgeAheadError; the row and branch are left intact.
 *   - A task whose branch has NO unique commits (ahead=0) is purged
 *     unconditionally regardless of the force flag.
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-purge-force-test-'))
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

describe('corePurgeTask — force flag', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet: force=true bypasses commit-ahead check ─────────────────

  it('with force=true, deletes the row and branch even when unique commits exist', async () => {
    const { q, pt } = await loadModules(repo)

    const task = await q.enqueueTask('important work', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'failed', error: 'test' })

    const branch = `task/${task.id}`
    makeBranchWithCommit(repo, branch)

    // Pre-condition: branch has unique commits ahead of main.
    const { listUniqueCommitsAhead } = await import('../../lib/sweep')
    const ahead = await listUniqueCommitsAhead(branch, 'main', repo)
    expect(ahead.length).toBeGreaterThan(0)

    // With force=true, purge should succeed.
    await expect(
      pt.corePurgeTask(task.id, true, 'main', repo),
    ).resolves.toMatchObject({ taskId: task.id })

    // Row is gone.
    expect(await q.getTask(task.id)).toBeNull()

    // Branch is gone.
    expect(branchExists(repo, branch)).toBe(false)
  })

  // ── force=false refuses when branch has unique commits ────────────────────

  it('without force, throws PurgeAheadError when branch has unique commits', async () => {
    const { q, pt } = await loadModules(repo)

    const task = await q.enqueueTask('precious work', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'failed', error: 'test' })

    const branch = `task/${task.id}`
    makeBranchWithCommit(repo, branch)

    // Without force, purge must refuse.
    await expect(
      pt.corePurgeTask(task.id, false, 'main', repo),
    ).rejects.toBeInstanceOf(pt.PurgeAheadError)

    // Row survives.
    expect(await q.getTask(task.id)).not.toBeNull()

    // Branch survives.
    expect(branchExists(repo, branch)).toBe(true)
  })

  it('PurgeAheadError names the task, branch, and unique commits', async () => {
    const { q, pt } = await loadModules(repo)

    const task = await q.enqueueTask('named work', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'done' })

    const branch = `task/${task.id}`
    makeBranchWithCommit(repo, branch)

    const err = await pt.corePurgeTask(task.id, false, 'main', repo).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(pt.PurgeAheadError)
    const ahead = err as InstanceType<typeof pt.PurgeAheadError>
    expect(ahead.taskId).toBe(task.id)
    expect(ahead.branch).toBe(branch)
    expect(ahead.commits.length).toBeGreaterThan(0)
    // The error message includes the branch name and a commit list.
    expect(ahead.message).toContain(branch)
    expect(ahead.message).toContain('unique commit')
  })

  // ── Zero commits ahead: purge proceeds without force ──────────────────────

  it('without force, purges a task whose branch has 0 commits ahead', async () => {
    const { q, pt } = await loadModules(repo)

    const task = await q.enqueueTask('empty branch work', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'done' })

    // Create a branch but don't add any commits (points at same commit as main).
    const branch = `task/${task.id}`
    execFileSync('git', ['branch', branch], { cwd: repo })

    // No commits ahead — purge must succeed without force.
    await expect(
      pt.corePurgeTask(task.id, false, 'main', repo),
    ).resolves.toMatchObject({ taskId: task.id })

    expect(await q.getTask(task.id)).toBeNull()
    expect(branchExists(repo, branch)).toBe(false)
  })

  // ── Non-existent branch: purge proceeds ───────────────────────────────────

  it('purges a task even when the branch does not exist (no git error)', async () => {
    const { q, pt } = await loadModules(repo)

    const task = await q.enqueueTask('no branch work', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'failed', error: 'test' })

    // Branch task/<id> is never created.
    await expect(
      pt.corePurgeTask(task.id, false, 'main', repo),
    ).resolves.toMatchObject({ taskId: task.id })

    expect(await q.getTask(task.id)).toBeNull()
  })

})
