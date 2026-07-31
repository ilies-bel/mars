/**
 * Regression: `verify:has-diff failed` on a diff that was never examined.
 *
 * TWO DISTINCT DEFECTS, both surfacing under the same misleading name because
 * `verifyChanges` reports any `assertWorktreeHygieneForVerify` throw as a step
 * literally called `has-diff` (git/verify.ts).
 *
 * 1. RELATIVE --git-path. `git rev-parse --git-path rebase-merge` returns an
 *    ABSOLUTE path inside a linked worktree but a RELATIVE one (`.git/rebase-
 *    merge`) in a plain repo. The hygiene probe passed that straight to
 *    `stat()`, which resolves relative paths against the DAEMON's process cwd
 *    rather than the worktree. When that cwd holds a `.git` FILE — true of
 *    every linked worktree — `stat` raises ENOTDIR, which the catch did not
 *    tolerate (it only allowed ENOENT), so a pristine tree was reported as
 *    carrying stale rebase state. The main-committer path verifies with
 *    `cwd = repoRoot`, a plain repo, so it took this every time.
 *
 * 2. VERIFY IS A RESUME ENTRY POINT. On a checkpoint-resume `setup` and `code`
 *    both short-circuit, so verify is the first step that really runs — and
 *    `restoreWorktreeIfMissing` lives inside the `code` step, i.e. exactly the
 *    step that gets skipped. Live: mars-a13334fd's recovery merged and removed
 *    the shared worktree + branch, and the origin then re-dispatched into a
 *    deleted directory ~10 times in under a minute.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

let repo: string

beforeEach(() => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-hygiene-paths-'))
  git(['init', '-q', '-b', 'main'], repo)
  git(['config', 'user.email', 'test@mars'], repo)
  git(['config', 'user.name', 'Mars Test'], repo)
  writeFileSync(resolve(repo, 'README'), 'hello\n')
  git(['add', 'README'], repo)
  git(['commit', '-q', '-m', 'init'], repo)
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('assertWorktreeHygieneForVerify — --git-path is resolved against the worktree', () => {
  it('accepts a clean PLAIN repo, where --git-path returns a relative path', async () => {
    const { assertWorktreeHygieneForVerify } = await import('../verify')
    git(['checkout', '-q', '-b', 'task/noop', 'main'], repo)

    // Precondition: this is the shape that broke. git hands back a relative
    // path, so a naive stat() would resolve it against process.cwd().
    const gitPath = git(['rev-parse', '--git-path', 'rebase-merge'], repo).trim()
    expect(gitPath).toBe('.git/rebase-merge')

    // The tree is pristine, so hygiene must pass. Before the fix this threw
    // `ENOTDIR: not a directory, stat '.git/rebase-merge'` whenever the test
    // runner's own cwd had a `.git` file — which is the daemon's situation.
    await expect(
      assertWorktreeHygieneForVerify(repo, 'task/noop'),
    ).resolves.toBeUndefined()
  })

  it('accepts a clean LINKED worktree, where --git-path returns an absolute path', async () => {
    const { assertWorktreeHygieneForVerify } = await import('../verify')
    const wt = resolve(repo, 'linked')
    git(['worktree', 'add', '-q', '-b', 'task/linked', wt, 'main'], repo)

    // Absolute, and pointing at this worktree's own admin dir (named after the
    // worktree DIRECTORY, not the branch).
    const linkedGitPath = git(['rev-parse', '--git-path', 'rebase-merge'], wt).trim()
    expect(linkedGitPath.startsWith('/')).toBe(true)
    expect(linkedGitPath).toContain('.git/worktrees/linked/rebase-merge')
    await expect(
      assertWorktreeHygieneForVerify(wt, 'task/linked'),
    ).resolves.toBeUndefined()
  })

  it('still catches GENUINE stale rebase state (the fix must not blind the probe)', async () => {
    const { assertWorktreeHygieneForVerify } = await import('../verify')
    git(['checkout', '-q', '-b', 'task/stale', 'main'], repo)
    mkdirSync(resolve(repo, '.git', 'rebase-merge'), { recursive: true })

    await expect(
      assertWorktreeHygieneForVerify(repo, 'task/stale'),
    ).rejects.toThrow(/stale rebase state present/)
  })

  it('still catches a wrong checked-out branch and a missing directory', async () => {
    const { assertWorktreeHygieneForVerify } = await import('../verify')
    git(['checkout', '-q', '-b', 'task/other', 'main'], repo)

    await expect(
      assertWorktreeHygieneForVerify(repo, 'task/expected'),
    ).rejects.toThrow(/worktree on wrong branch/)

    await expect(
      assertWorktreeHygieneForVerify(resolve(repo, 'gone'), 'task/other'),
    ).rejects.toThrow(/no longer exists/)
  })
})

describe('verifyChanges — a no-op branch in a plain repo reaches the real gate', () => {
  it('passes zero-ahead as benign instead of dying in the hygiene probe', async () => {
    const { verifyChanges } = await import('../git/verify')
    git(['checkout', '-q', '-b', 'task/noop', 'main'], repo)

    const r = await verifyChanges({
      cwd: repo,
      steps: [],
      branch: 'task/noop',
      integrationBranch: 'main',
    })

    // The whole point: has-diff must be a REAL verdict about the diff, not a
    // hygiene throw wearing the has-diff name.
    expect(r.passed).toBe(true)
    expect(r.steps.map((s) => s.name)).toEqual(['has-diff'])
    expect(r.steps[0]?.passed).toBe(true)
    expect(r.steps[0]?.output).toContain('no-op accepted')
  })
})

/**
 * The resume hole: verify runs with setup and code both skipped, so nothing
 * has revalidated the worktree. `restoreWorktreeIfMissing` is the same repair
 * `runAgent` performs; these assert it behaves correctly for the two shapes
 * verify can meet, since the primitive itself needs the full daemon ctx.
 */
describe('resume into a vanished worktree — repair, or fail once with a named signature', () => {
  const originalRepoEnv = process.env.MARS_REPO

  afterEach(async () => {
    if (originalRepoEnv === undefined) delete process.env.MARS_REPO
    else process.env.MARS_REPO = originalRepoEnv
    const { __resetContextCacheForTests } = await import('../../context')
    __resetContextCacheForTests()
  })

  const useRepo = async (): Promise<void> => {
    process.env.MARS_REPO = repo
    const { __resetContextCacheForTests } = await import('../../context')
    __resetContextCacheForTests()
  }

  it('re-attaches the worktree when the branch (and its commits) survive', async () => {
    await useRepo()
    const { restoreWorktreeIfMissing } = await import('../git/worktree')
    const wt = resolve(repo, '.mars/worktrees/mars-resume')
    mkdirSync(resolve(wt, '..'), { recursive: true })
    git(['worktree', 'add', '-q', '-b', 'task/mars-resume', wt, 'main'], repo)
    writeFileSync(resolve(wt, 'work.ts'), 'export const x = 1\n')
    git(['add', 'work.ts'], wt)
    git(['commit', '-q', '-m', 'coder work'], wt)
    const tip = git(['rev-parse', 'task/mars-resume'], repo).trim()

    // A recovery merged and cleaned up the shared directory while the origin
    // was parked — exactly the mars-a13334fd shape.
    rmSync(wt, { recursive: true, force: true })
    expect(existsSync(wt)).toBe(false)

    const outcome = await restoreWorktreeIfMissing({
      taskId: 'mars-resume',
      ref: { path: wt, branch: 'task/mars-resume' },
    })

    expect(outcome).toBe('rebuilt')
    expect(existsSync(wt)).toBe(true)
    // The committed work is intact, so verify now has something real to run.
    expect(git(['rev-parse', 'HEAD'], wt).trim()).toBe(tip)
    expect(existsSync(resolve(wt, 'work.ts'))).toBe(true)
  })

  it('reports unrecoverable (branch gone too) so verify fails once, not forever', async () => {
    await useRepo()
    const { restoreWorktreeIfMissing, ResumeWorktreeUnrecoverable } = await import(
      '../git/worktree'
    )
    await expect(
      restoreWorktreeIfMissing({
        taskId: 'mars-gone',
        ref: {
          path: resolve(repo, '.mars/worktrees/mars-gone'),
          branch: 'task/mars-gone',
        },
      }),
    ).rejects.toBeInstanceOf(ResumeWorktreeUnrecoverable)
  })

  it('classifies verify:worktree-missing as orchestration, never as a code defect', async () => {
    const { classifyFailure, isNonCodeFailure } = await import('../failure-class')
    const sig = 'verify:worktree-missing/unclassified'
    // A code fixer cannot edit a tree that does not exist; routing this to one
    // would burn the single recovery slot.
    expect(classifyFailure(sig)).toBe('orchestration')
    expect(isNonCodeFailure(sig)).toBe(true)
  })
})
