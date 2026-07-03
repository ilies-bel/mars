/**
 * Regression tests for the post-merge dirty-tree invariant in `mergeBranch`.
 *
 * Incident (2026-07-02): the merge step returned `merged: true` while leaving
 * 18 files in the primary checkout in a mixed state matching no single
 * historical HEAD. Every subsequent dispatch parked behind a main-committer
 * Chore fix until an operator manually cleaned up.
 *
 * Fix: `mergeBranch` now asserts `git status --porcelain` is empty on the
 * integration checkout before returning success. If dirty it attempts a
 * `git reset --hard HEAD` restore and returns `{ merged: false,
 * reason: 'merge-left-dirty-tree' }`.
 *
 * Tests:
 *
 *  1. Non-FF path (real rebase) — the integration checkout is clean after a
 *     successful rebase + fast-forward merge. This is the primary regression
 *     guard for the incident: Step 3 must leave no phantom staged changes.
 *
 *  2. Dirty-tree detection — when the integration checkout is dirty after the
 *     fast-forward (simulated via `onBeforeFastForward` leaving working-tree
 *     changes that cause Step 3 to skip), the post-merge assertion detects it,
 *     restores the tree, and returns the distinct reason `'merge-left-dirty-tree'`.
 *
 * All tests use real git repos — no git operations are mocked.
 * They do NOT touch the DB or the task store.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { mergeBranch } from '../git/merge'
import { __resetContextCacheForTests } from '../../context'

const GIT = 'git'

const git = (args: string[], cwd: string): string =>
  execFileSync(GIT, args, { cwd, encoding: 'utf8' }).trim()

// ──────────────────────────────────────────────────────────────────────────────
// Shared repo fixture
//
// We create the git objects once and reset branches between tests rather than
// recreating the repo for each test — mirrors what merge-integration-gate.test
// does. Each test calls resetBranches() to restore main + task/feat to their
// original SHAs before exercising mergeBranch.
// ──────────────────────────────────────────────────────────────────────────────

interface Fixture {
  /** Primary checkout, on `main`. MARS_REPO is pointed here. */
  primaryRepo: string
  /**
   * Separate git worktree checked out on `task/feat`.
   * Used as `worktreePath` so Step 1's `git rebase` runs on the task branch,
   * not on `main` — matching production where each task has its own worktree.
   */
  taskWorktree: string
  /** SHA of the shared base commit (A). */
  baseSha: string
  /**
   * SHA of the extra commit added to `main` after the task branch diverged (B).
   * After setup: main = A → B,  task/feat = A → C
   */
  mainExtraSha: string
  /** SHA of the feature commit on task/feat (C, before any rebase). */
  taskOrigSha: string
}

let fix: Fixture
let prevMarsRepo: string | undefined

const resetBranches = (f: Fixture): void => {
  // Hard-reset main to B (mainExtraSha) and working tree.
  execFileSync(GIT, ['checkout', '-q', 'main'], { cwd: f.primaryRepo })
  execFileSync(GIT, ['reset', '--hard', f.mainExtraSha], { cwd: f.primaryRepo })

  // Hard-reset task/feat to C (taskOrigSha) in the task worktree.
  execFileSync(GIT, ['reset', '--hard', f.taskOrigSha], { cwd: f.taskWorktree })
}

beforeAll(() => {
  // ── 1. Primary repo ─────────────────────────────────────────────────────────
  const primaryRepo = mkdtempSync(resolve(tmpdir(), 'mars-dirty-tree-'))

  const g = (args: string[]) =>
    execFileSync(GIT, args, { cwd: primaryRepo, encoding: 'utf8' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 'test@mars.test'])
  g(['config', 'user.name', 'Mars Test'])

  // Commit A — shared base
  writeFileSync(resolve(primaryRepo, 'README'), 'base\n')
  g(['add', 'README'])
  g(['commit', '-q', '-m', 'base'])
  const baseSha = git(['rev-parse', 'main'], primaryRepo)

  // Branch task/feat at A, add commit C (feature.txt)
  g(['checkout', '-q', '-b', 'task/feat'])
  writeFileSync(resolve(primaryRepo, 'feature.txt'), 'feature\n')
  g(['add', 'feature.txt'])
  g(['commit', '-q', '-m', 'add feature'])
  const taskOrigSha = git(['rev-parse', 'task/feat'], primaryRepo)

  // Return to main, add commit B (extra.txt)
  // → main = A→B,  task/feat = A→C  (non-FF scenario)
  g(['checkout', '-q', 'main'])
  writeFileSync(resolve(primaryRepo, 'extra.txt'), 'extra\n')
  g(['add', 'extra.txt'])
  g(['commit', '-q', '-m', 'extra on main'])
  const mainExtraSha = git(['rev-parse', 'main'], primaryRepo)

  // ── 2. Separate git worktree for task/feat ──────────────────────────────────
  //
  // Production: the daemon's primary checkout stays on `main` while each task
  // gets its own worktree checked out on the task branch. Without this
  // separation, `git rebase main` in Step 1 would rebase `main` onto itself
  // (a no-op) instead of rebasing the task branch — hiding the non-FF path.
  const taskWorktree = mkdtempSync(resolve(tmpdir(), 'mars-dirty-tree-task-'))
  // Remove the blank dir before git worktree add (it requires a non-existent or
  // empty dir — mkdtempSync creates it).
  rmSync(taskWorktree, { recursive: true, force: true })
  execFileSync(GIT, ['worktree', 'add', taskWorktree, 'task/feat'], {
    cwd: primaryRepo,
  })
  execFileSync(GIT, ['config', 'user.email', 'test@mars.test'], {
    cwd: taskWorktree,
  })
  execFileSync(GIT, ['config', 'user.name', 'Mars Test'], {
    cwd: taskWorktree,
  })

  // ── 3. Override MARS_REPO ───────────────────────────────────────────────────
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = primaryRepo
  __resetContextCacheForTests()

  fix = { primaryRepo, taskWorktree, baseSha, mainExtraSha, taskOrigSha }
})

afterAll(() => {
  if (prevMarsRepo !== undefined) {
    process.env.MARS_REPO = prevMarsRepo
  } else {
    delete process.env.MARS_REPO
  }
  __resetContextCacheForTests()

  try {
    execFileSync(GIT, ['worktree', 'remove', '--force', fix.taskWorktree], {
      cwd: fix.primaryRepo,
    })
  } catch {
    rmSync(fix.taskWorktree, { recursive: true, force: true })
  }
  rmSync(fix.primaryRepo, { recursive: true, force: true })
})

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('mergeBranch — post-merge clean-tree invariant', () => {
  it('leaves the integration checkout with an empty git status after a non-FF rebase merge', async () => {
    // Regression for the 2026-07-02 incident: the non-FF (rebase) path left
    // 18 files in a mixed state on the primary checkout.
    //
    // Scenario:
    //   main:      A → B  (B = "extra on main")
    //   task/feat: A → C  (C = "add feature"; branched from A, before B)
    //
    // mergeBranch must:
    //   Step 1  rebase task/feat onto main → A → B → C'
    //   Step 2  fast-forward main from B to C'
    //   Step 3  git reset --hard C' in primary checkout
    //   Assert  git status --porcelain on primary checkout is empty

    resetBranches(fix)

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: fix.taskWorktree,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
    })

    expect(result.merged, `merge output:\n${result.output}`).toBe(true)
    expect(result.aborted).toBe(false)
    expect(result.reason).toBeUndefined()

    // The integration checkout MUST be perfectly clean.
    const statusOutput = git(['status', '--porcelain'], fix.primaryRepo)
    expect(statusOutput).toBe('')

    // main must now include both extra.txt (B) and feature.txt (C').
    const mainSha = git(['rev-parse', 'main'], fix.primaryRepo)
    const hasFeature = (() => {
      try {
        execFileSync(GIT, ['cat-file', '-e', `${mainSha}:feature.txt`], {
          cwd: fix.primaryRepo,
        })
        return true
      } catch {
        return false
      }
    })()
    expect(hasFeature).toBe(true)

    const hasExtra = (() => {
      try {
        execFileSync(GIT, ['cat-file', '-e', `${mainSha}:extra.txt`], {
          cwd: fix.primaryRepo,
        })
        return true
      } catch {
        return false
      }
    })()
    expect(hasExtra).toBe(true)
  })

  it('detects a dirty integration checkout after merge and returns merge-left-dirty-tree', async () => {
    // Simulate a scenario where the integration checkout ends up dirty after
    // the fast-forward: we use `onBeforeFastForward` to modify a tracked file
    // in the primary checkout's working tree without staging it.
    //
    // Sequence inside mergeBranch:
    //   Step 1  rebase succeeds → task/feat → C'
    //   Step 2  onBeforeFastForward: README is dirtied in primary checkout
    //           update-ref advances main to C'
    //   Step 3  git diff --quiet mainExtraSha → non-zero (README is dirty)
    //           → cleanVsOldHead = false → Step 3 SKIPPED to avoid clobbering
    //   Assert  git status --porcelain → dirty → restore + return
    //             { merged: false, reason: 'merge-left-dirty-tree' }
    //
    // NOTE: main's ref IS advanced by update-ref before the assertion fires.
    // The 'merge-left-dirty-tree' reason signals a tree-sync problem, not a
    // lost merge — the commit has landed.

    resetBranches(fix)

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: fix.taskWorktree,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
      onBeforeFastForward: async () => {
        // Dirty the primary checkout's working tree by modifying a tracked
        // file without staging it. README exists at baseSha so it is known
        // to both commits on either side of the merge.
        writeFileSync(resolve(fix.primaryRepo, 'README'), 'locally modified\n')
      },
    })

    // The post-merge assertion must have fired.
    expect(result.merged).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.integrationGateFailed).toBeFalsy()
    expect(result.reason).toBe('merge-left-dirty-tree')
    expect(result.output).toContain('dirty-tree detected')

    // The restoration attempt must leave the tree clean so dispatches can resume.
    const statusAfter = git(['status', '--porcelain'], fix.primaryRepo)
    expect(statusAfter).toBe('')

    // Even though merged:false, main's ref was advanced by update-ref — the
    // 'merge-left-dirty-tree' outcome is a tree-sync failure, not a lost commit.
    const currentMain = git(['rev-parse', 'main'], fix.primaryRepo)
    expect(currentMain).not.toBe(fix.mainExtraSha) // ref DID advance
  })
})
