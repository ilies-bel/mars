/**
 * Tests for the already-merged no-op path in `mergeBranch` and the
 * `isBranchTipInIntegration` guard.
 *
 * Regression coverage for: "already-merged no-op bypasses post-merge ancestry
 * assertion, silently orphaning commits" (mars-5fa9bb9f).
 *
 * The bug: when the already-merged short-circuit fired in `mergeBranch`
 * (aheadCount === 0 && taskIsAncestorOfIntegration), the returned `MergeResult`
 * did not include `mergePostSha`.  The caller's post-merge ancestry assertion
 * in `tools/merge/merge.ts` is gated on `m.mergePostSha !== undefined`, so it
 * was silently skipped for every no-op, leaving the task marked done even if
 * the no-op determination was wrong (false-done tombstone; commits orphaned).
 *
 * Fix: the no-op path now reads the branch tip SHA and returns it as
 * `mergePostSha`, enabling the caller assertion to run unconditionally.
 *
 * These tests verify:
 *   1. The no-op result includes `mergePostSha` set to the branch tip SHA.
 *   2. `isBranchTipInIntegration` correctly identifies ancestry — this is the
 *      guard the caller uses to validate `mergePostSha` before marking done.
 *   3. `isBranchTipInIntegration` returns `false` for a SHA not in integration,
 *      confirming the post-merge assertion would catch a wrong no-op if the
 *      branch tip is not genuinely contained in integration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { mergeBranch, isBranchTipInIntegration } from './merge.js'
import { __resetContextCacheForTests } from '../../context.js'

// ---------------------------------------------------------------------------
// Test-repo helpers
// ---------------------------------------------------------------------------

let repoDir: string
let prevMarsRepo: string | undefined

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()

const commitFile = (name: string, contents: string, message: string): void => {
  writeFileSync(resolve(repoDir, name), contents)
  git('add', name)
  git('commit', '-m', message)
}

beforeAll(() => {
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-noop-sha-test-'))
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')

  // c1: initial commit on main; branch the task off c1 and add c2 (task work).
  commitFile('a.txt', 'a', 'c1')
  git('branch', 'task/feat')
  git('checkout', 'task/feat')
  commitFile('b.txt', 'b', 'c2')

  // Fast-forward main to include the task's work ...
  git('checkout', 'main')
  git('merge', '--ff-only', 'task/feat')

  // ... then advance main with c3 so it is AHEAD of task/feat (0-ahead branch).
  commitFile('c.txt', 'c', 'c3')

  // Sanity: task/feat is 0 commits ahead of main.
  expect(git('rev-list', '--count', 'main..task/feat')).toBe('0')
})

afterAll(() => {
  if (prevMarsRepo !== undefined) {
    process.env.MARS_REPO = prevMarsRepo
  } else {
    delete process.env.MARS_REPO
  }
  __resetContextCacheForTests()
  rmSync(repoDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Suite 1 — already-merged no-op returns mergePostSha (the fix)
// ---------------------------------------------------------------------------

describe('mergeBranch already-merged no-op — mergePostSha is set', () => {
  it(
    'returns the branch tip SHA as mergePostSha so the caller post-merge assertion runs',
    async () => {
      const taskBranchTip = git('rev-parse', 'task/feat')

      const result = await mergeBranch({
        branch: 'task/feat',
        worktreePath: repoDir,
        integrationBranch: 'main',
        lockTimeoutMs: 5_000,
        watchdogMs: 10_000,
      })

      expect(result.merged).toBe(true)
      expect(result.aborted).toBe(false)
      // The fix: mergePostSha must be set to the branch tip so the caller's
      // isBranchTipInIntegration assertion runs rather than being skipped.
      expect(result.mergePostSha).toBe(taskBranchTip)
    },
    15_000,
  )

  it(
    'omits mergePreSha (no fast-forward took place in a no-op)',
    async () => {
      const result = await mergeBranch({
        branch: 'task/feat',
        worktreePath: repoDir,
        integrationBranch: 'main',
        lockTimeoutMs: 5_000,
        watchdogMs: 10_000,
      })

      // mergePreSha records the pre-fast-forward integration tip.
      // For a no-op there is no fast-forward, so mergePreSha is absent.
      expect(result.mergePreSha).toBeUndefined()
    },
    15_000,
  )
})

// ---------------------------------------------------------------------------
// Suite 2 — isBranchTipInIntegration: the guard used by the post-merge
//            assertion to validate mergePostSha before marking task done
// ---------------------------------------------------------------------------

describe('isBranchTipInIntegration', () => {
  it('returns true when the SHA is the current integration tip', async () => {
    const mainTip = git('rev-parse', 'main')
    expect(await isBranchTipInIntegration(mainTip, 'main')).toBe(true)
  })

  it('returns true when the SHA is an ancestor of the integration branch', async () => {
    // main~1 is one commit behind the current main tip but still an ancestor.
    const ancestor = git('rev-parse', 'main~1')
    expect(await isBranchTipInIntegration(ancestor, 'main')).toBe(true)
  })

  it(
    'returns false for a SHA that is NOT in the integration branch ancestry — ' +
    'this is the condition the post-merge assertion fires on to catch a wrong no-op',
    async () => {
      // Create an orphan commit that is not reachable from main.
      // This simulates: task branch had a work commit (workSha) that was
      // NEVER fast-forwarded into integration, but the already-merged check
      // incorrectly fired (e.g. the branch was force-reset to an ancestor).
      // The post-merge assertion receives mergePostSha = workSha and calls
      // isBranchTipInIntegration(workSha, integration) → false → task fails.
      const orphanRef = 'refs/test/orphan-work-commit'
      git('checkout', '--orphan', '_orphan_tmp')
      commitFile('orphan.txt', 'orphan', 'orphan work commit')
      const orphanSha = git('rev-parse', 'HEAD')
      git('update-ref', orphanRef, orphanSha)
      // Clean up orphan branch; the ref still holds the commit
      git('checkout', 'main')
      git('branch', '-D', '_orphan_tmp')

      // Confirm the orphan is NOT reachable from main
      expect(
        await isBranchTipInIntegration(orphanSha, 'main'),
      ).toBe(false)

      // Clean up the test ref
      git('update-ref', '-d', orphanRef)
    },
    15_000,
  )

  it(
    'returns false for the task branch tip when the task work was NOT merged — ' +
    'regression for the mars-59c9fdb0 false-done scenario',
    async () => {
      // Create a NEW task branch whose work has never been merged into main.
      // Simulates: the coder produced commits, but the branch was never
      // fast-forwarded (e.g. the merge step erroneously declared no-op before
      // the work landed). The work commit is therefore not in main's ancestry.
      git('checkout', 'main')
      git('checkout', '-b', '_unmerged_task')
      commitFile('unmerged.txt', 'unmerged task work', 'unmerged: task commit')
      const unmergedTip = git('rev-parse', 'HEAD')
      git('checkout', 'main')
      git('branch', '-D', '_unmerged_task')

      // The work commit is not reachable from main — isBranchTipInIntegration
      // must return false so the post-merge assertion would fail the task.
      expect(
        await isBranchTipInIntegration(unmergedTip, 'main'),
      ).toBe(false)
    },
    15_000,
  )
})
