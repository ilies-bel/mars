/**
 * Tests for worktreeRemovalGuard.
 *
 * The guard has two branches:
 *   (a) Directory-mtime guard — tested with a real temp directory and an
 *       injectable `nowMs` to avoid wall-clock timing dependencies.
 *   (b) Uncommitted-changes guard — tested against the REAL git binary so
 *       that a code path change (e.g. wrong flag) surfaces as a test failure
 *       rather than a silent stub pass.  (Coding discipline: cross-boundary
 *       changes need real-boundary verification.)
 *
 * The integration between the guard and the runners (runWorktreeClean /
 * runWorktreePrune) is covered by the `guardCheck` injectable option on each
 * runner's RunOptions; runner-level unit tests are omitted because the runners
 * depend on `resolveContext()` (which requires a live Mars DB) and are not
 * constructable in isolation.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RECENT_MTIME_GUARD_MS, worktreeRemovalGuard } from '../worktree-clean'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Create a temp directory and return its path + mtime. */
const makeTmpDir = async (): Promise<{ path: string; mtimeMs: number }> => {
  const path = await mkdtemp(join(tmpdir(), 'mars-guard-test-'))
  const { mtimeMs } = statSync(path)
  return { path, mtimeMs }
}

/**
 * Return a `nowMs` value that makes the directory appear old enough to pass
 * the mtime guard (age ≥ RECENT_MTIME_GUARD_MS + 1 s).
 */
const oldEnoughNow = (dirMtimeMs: number): number =>
  dirMtimeMs + RECENT_MTIME_GUARD_MS + 1_000

// ── mtime guard ──────────────────────────────────────────────────────────────

describe('worktreeRemovalGuard — mtime guard', () => {
  let tmpDir: string

  beforeEach(async () => {
    ;({ path: tmpDir } = await makeTmpDir())
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('blocks removal when directory mtime is younger than threshold', async () => {
    // nowMs = now → age ≈ 0 ms → blocked
    const reason = await worktreeRemovalGuard(tmpDir, Date.now())
    expect(reason).toMatch(/directory mtime is \d+m old/)
    expect(reason).toMatch(/threshold: 30m/)
  })

  it('does not block on mtime when directory is old enough', async () => {
    const { mtimeMs } = statSync(tmpDir)
    // Advance nowMs past the threshold; tmpDir is an empty non-git directory,
    // so git status fails (not a worktree) → guard returns null.
    const reason = await worktreeRemovalGuard(tmpDir, oldEnoughNow(mtimeMs))
    // An empty dir is not a git repo — git status returns non-zero exit →
    // dirty guard passes → overall guard passes.
    expect(reason).toBeNull()
  })

  it('does not block when the path does not exist', async () => {
    // stat throws → mtime guard skipped; git status fails → dirty guard
    // skipped → null.
    const reason = await worktreeRemovalGuard(
      '/nonexistent/mars-guard-path-xyz',
      Date.now(),
    )
    expect(reason).toBeNull()
  })
})

// ── uncommitted-changes guard (real git binary) ───────────────────────────────

describe('worktreeRemovalGuard — uncommitted-changes guard (real git)', () => {
  let gitDir: string

  beforeEach(async () => {
    gitDir = await mkdtemp(join(tmpdir(), 'mars-guard-git-test-'))
    // Minimal git repo — enough for `git status --porcelain` to work.
    execFileSync('git', ['init', '-b', 'main'], { cwd: gitDir, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: gitDir,
      stdio: 'pipe',
    })
    execFileSync('git', ['config', 'user.name', 'Test'], {
      cwd: gitDir,
      stdio: 'pipe',
    })
  })

  afterEach(async () => {
    await rm(gitDir, { recursive: true, force: true })
  })

  it('blocks removal when the git repo has uncommitted changes', async () => {
    // Write a file directly in the git root (not staged/committed).
    await writeFile(join(gitDir, 'dirty.txt'), 'uncommitted work')
    // Use the post-write mtime to compute an "old" nowMs so the mtime guard
    // does not interfere.
    const { mtimeMs } = statSync(gitDir)
    const reason = await worktreeRemovalGuard(gitDir, oldEnoughNow(mtimeMs))
    expect(reason).toMatch(/uncommitted change/)
    expect(reason).toMatch(/explicit purge/)
  })

  it('blocks removal when staged but not committed changes exist', async () => {
    await writeFile(join(gitDir, 'staged.txt'), 'staged work')
    execFileSync('git', ['add', 'staged.txt'], { cwd: gitDir, stdio: 'pipe' })
    const { mtimeMs } = statSync(gitDir)
    const reason = await worktreeRemovalGuard(gitDir, oldEnoughNow(mtimeMs))
    expect(reason).toMatch(/uncommitted change/)
  })

  it('does not block removal on a clean repo with no changes', async () => {
    // Fresh git init — git status --porcelain returns empty output.
    const { mtimeMs } = statSync(gitDir)
    const reason = await worktreeRemovalGuard(gitDir, oldEnoughNow(mtimeMs))
    expect(reason).toBeNull()
  })

  it('does not block when git status returns empty after a clean commit', async () => {
    await writeFile(join(gitDir, 'readme.txt'), 'hello')
    execFileSync('git', ['add', 'readme.txt'], { cwd: gitDir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: gitDir, stdio: 'pipe' })
    // After commit, git status --porcelain should be empty.
    const { mtimeMs } = statSync(gitDir)
    const reason = await worktreeRemovalGuard(gitDir, oldEnoughNow(mtimeMs))
    expect(reason).toBeNull()
  })
})
