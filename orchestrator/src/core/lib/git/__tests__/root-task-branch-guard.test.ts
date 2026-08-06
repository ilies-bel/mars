/**
 * Guard: `git checkout task/*` must throw before switching the integration
 * checkout, and HEAD must remain on `main`.
 *
 * Regression for 2026-08-05: the daemon checked out task/mars-fe86ca8f at the
 * repo root while a Worker was operating there. The integration checkout's HEAD
 * moved off `main`, contaminating the merge target for every in-flight task
 * and producing the `rescue/main-dirty-*` branches already visible in this
 * repo's branch list.
 *
 * The guard lives in `runShell` (internal.ts) so both `exec` and `execProbe`
 * are covered regardless of which code path issues the bad checkout.
 *
 * Tests drive real git in a temp repo so the "HEAD stayed on main" assertion
 * cannot be faked by a stub.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

let repoRoot: string
const originalRepoEnv = process.env.MARS_REPO

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

const currentBranch = (): string =>
  git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim()

beforeEach(async () => {
  repoRoot = mkdtempSync(resolve(tmpdir(), 'mars-root-guard-'))
  git(['init', '-b', 'main'], repoRoot)
  git(['config', 'user.email', 'test@mars'], repoRoot)
  git(['config', 'user.name', 'Mars Test'], repoRoot)
  writeFileSync(resolve(repoRoot, 'readme.txt'), 'base\n')
  git(['add', 'readme.txt'], repoRoot)
  git(['commit', '-m', 'base'], repoRoot)
  // Create a task branch so the checkout would succeed without the guard.
  git(['branch', 'task/mars-fe86ca8f'], repoRoot)

  process.env.MARS_REPO = repoRoot
  const { __resetContextCacheForTests } = await import('../../../context')
  __resetContextCacheForTests()
})

afterEach(async () => {
  if (originalRepoEnv === undefined) delete process.env.MARS_REPO
  else process.env.MARS_REPO = originalRepoEnv
  const { __resetContextCacheForTests } = await import('../../../context')
  __resetContextCacheForTests()
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('git-guard: task/* branch must not be checked out at the repo root', () => {
  it('exec throws before switching when git checkout targets a task/* branch at the root', async () => {
    const { exec, resolveGitBin, TaskBranchAtRootError } = await import('../internal')
    const gitBin = resolveGitBin()

    await expect(
      exec(gitBin, ['checkout', 'task/mars-fe86ca8f'], { cwd: repoRoot }),
    ).rejects.toThrow(TaskBranchAtRootError)

    // The integration checkout HEAD must still be on main — the branch switch
    // never reached git.
    expect(currentBranch()).toBe('main')
  })

  it('execProbe also fires the guard for a task/* checkout at the root', async () => {
    const { execProbe, resolveGitBin, TaskBranchAtRootError } = await import('../internal')
    const gitBin = resolveGitBin()

    await expect(
      execProbe(gitBin, ['checkout', 'task/mars-fe86ca8f'], { cwd: repoRoot }),
    ).rejects.toThrow(TaskBranchAtRootError)

    expect(currentBranch()).toBe('main')
  })

  it('allows checkout of a non-task branch at the repo root', async () => {
    const { exec, resolveGitBin, TaskBranchAtRootError } = await import('../internal')
    const gitBin = resolveGitBin()

    // Create a feature branch to switch to (otherwise git errors "already on main")
    git(['branch', 'feature/something'], repoRoot)
    await expect(
      exec(gitBin, ['checkout', 'feature/something'], { cwd: repoRoot }),
    ).resolves.toBeDefined()

    // Switching back — our guard must not fire for non-task branches
    await expect(
      exec(gitBin, ['checkout', 'main'], { cwd: repoRoot }),
    ).resolves.toBeDefined()
  })

  it('allows path-restore checkout of a task/* ref at the repo root', async () => {
    // `git checkout task/<id> -- <file>` is a path-restore: it does NOT move
    // HEAD. The `--` separator is the distinguishing marker.
    const { exec, resolveGitBin, TaskBranchAtRootError } = await import('../internal')
    const gitBin = resolveGitBin()

    // The guard must not fire (git may still fail for other reasons, e.g. the
    // file is identical on both branches — that is fine).
    try {
      await exec(gitBin, ['checkout', 'task/mars-fe86ca8f', '--', 'readme.txt'], {
        cwd: repoRoot,
      })
    } catch (err) {
      // If git itself throws (file identical / merge conflict), that is
      // expected. What must NOT happen is our guard firing.
      expect(err).not.toBeInstanceOf(TaskBranchAtRootError)
    }

    // HEAD is still on main — path-restore does not move it.
    expect(currentBranch()).toBe('main')
  })

  it('blocks git checkout -b task/* (create-and-switch) at the repo root', async () => {
    // Branch-creation forms also switch HEAD and must be blocked.
    const { exec, resolveGitBin, TaskBranchAtRootError } = await import('../internal')
    const gitBin = resolveGitBin()

    await expect(
      exec(gitBin, ['checkout', '-b', 'task/mars-new-branch'], { cwd: repoRoot }),
    ).rejects.toThrow(TaskBranchAtRootError)

    expect(currentBranch()).toBe('main')
  })

  it('allows git worktree add -b task/* at the repo root (createWorktree path)', async () => {
    // `git worktree add -b task/<id> <path>` is the canonical way the
    // orchestrator provisions a new linked worktree. It does NOT move the
    // integration checkout's HEAD — it creates a new, separate working tree
    // and is therefore exempt from the guard.
    //
    // This is NOT a `git checkout` invocation, so `assertNotTaskBranchAtRoot`
    // never fires. This test confirms that the guard does not accidentally
    // intercept unrelated sub-commands.
    const { exec, resolveGitBin, TaskBranchAtRootError } = await import('../internal')
    const gitBin = resolveGitBin()

    const worktreePath = resolve(repoRoot, '.mars', 'worktrees', 'mars-newbranch')
    // worktree add does NOT fire our guard (args[0] = 'worktree', not 'checkout').
    await expect(
      exec(gitBin, ['worktree', 'add', '-b', 'task/mars-newbranch', worktreePath], {
        cwd: repoRoot,
      }),
    ).resolves.toBeDefined()

    // The integration checkout HEAD must still be on main — worktree add never
    // moves the primary checkout.
    expect(currentBranch()).toBe('main')
  })
})
