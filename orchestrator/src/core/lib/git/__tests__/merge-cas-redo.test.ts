/**
 * ADR-0100 step 4: the fast-forward is an optimistic-concurrency (CAS) loop.
 *
 * `mergeBranch` captures `base` (the integration tip) via `git rev-parse
 * <integrationBranch>` before rebasing, rebases + verifies the task branch
 * onto it, then takes `.merge.lock` only long enough to re-read the
 * integration tip and land the fast-forward with the OLD-VALUE CAS form of
 * `git update-ref` (`update-ref <ref> <new> <old>`), which git itself
 * rejects if the ref moved since `base` was read. On a mismatch mergeBranch
 * releases the lock, bumps `retriesAttempted`, and redoes rebase+verify from
 * the NEW base — it never lands an unverified composition.
 *
 * This test simulates exactly that race: `onBeforeFastForward` (a TEST-ONLY
 * seam awaited immediately before the CAS `update-ref`) commits directly onto
 * `main` in the primary checkout on its first invocation only — a stand-in
 * for a second merge or an operator commit landing between this merge's
 * verify and its CAS. The task branch lives in a real linked git worktree so
 * the redo's rebase genuinely re-lands the task commit on the new base,
 * rather than being a no-op.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { mergeBranch, type MergeGateOutcome } from '../merge'
import { __resetContextCacheForTests, getStateDir } from '../../../context'

let repoDir: string
let worktreeDir: string
let prevMarsRepo: string | undefined
/** main's tip before any merge under test — restored before every test. */
let mainSha: string
/** task/feat's (pre-rebase) tip — restored before every test. */
let featSha: string

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const commitFile = (name: string, contents: string, message: string): void => {
  writeFileSync(resolve(repoDir, name), contents)
  git('add', name)
  git('commit', '-m', message)
}

beforeAll(() => {
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-cas-redo-'))
  worktreeDir = `${repoDir}-wt`
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')

  // `getStateDir()` materialises `.mars/` inside the repo. A real Mars repo
  // gitignores it; without the same ignore here it shows up as untracked and
  // trips the pre-rebase dirty-worktree guard.
  commitFile('.gitignore', '.mars/\n', 'c0: ignore orchestrator state')

  // main: c1. task/feat branches at c1 and adds c2 (touching a different file
  // than the concurrent advance below, so the redo's rebase never conflicts).
  commitFile('a.txt', 'a', 'c1')
  git('branch', 'task/feat')
  git('worktree', 'add', '--quiet', worktreeDir, 'task/feat')
  writeFileSync(resolve(worktreeDir, 'b.txt'), 'b')
  gitIn(worktreeDir, 'add', 'b.txt')
  gitIn(worktreeDir, 'commit', '-m', 'c2')

  mainSha = git('rev-parse', 'main')
  featSha = git('rev-parse', 'task/feat')
})

beforeEach(() => {
  // MARS_REPO and the resolved-context cache are process-globals that sibling
  // merge suites clear in their own afterAll; re-pin before every test.
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()
  // Rewind both refs so each test starts from the same diverged shape.
  git('reset', '--hard', mainSha)
  gitIn(worktreeDir, 'reset', '--hard', featSha)
})

afterAll(() => {
  if (prevMarsRepo !== undefined) {
    process.env.MARS_REPO = prevMarsRepo
  } else {
    delete process.env.MARS_REPO
  }
  __resetContextCacheForTests()
  rmSync(worktreeDir, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

describe('mergeBranch — CAS fast-forward redo on concurrent base advance', () => {
  it('redoes rebase+verify exactly once when main advances between verify and CAS, then lands', async () => {
    let injected = false
    const verifyCalls: Array<{ baseSha: string; taskSha: string; attempt: number }> = []

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
      onVerifyRebasedTree: async (info): Promise<MergeGateOutcome> => {
        verifyCalls.push(info)
        return { passed: true }
      },
      // TEST-ONLY seam: fires inside the lock, immediately before the CAS
      // update-ref. On the first call only, commit directly onto `main` in
      // the primary checkout — simulating a second merge / operator commit
      // landing in the window between this attempt's verify and its CAS.
      onBeforeFastForward: async (): Promise<void> => {
        if (injected) return
        injected = true
        commitFile('c.txt', 'c', 'c3: concurrent advance of main')
      },
    })

    expect(result.merged).toBe(true)
    expect(result.aborted).toBe(false)
    // Exactly one redo: the concurrent advance is injected once, so the CAS
    // must be rejected once and succeed on the second attempt.
    expect(result.retriesAttempted).toBe(1)

    // The whole rebase+verify was redone from the NEW base, not resumed: two
    // verify calls, the second one's baseSha is the concurrently-advanced tip.
    expect(verifyCalls).toHaveLength(2)
    expect(verifyCalls[0]?.attempt).toBe(1)
    expect(verifyCalls[0]?.baseSha).toBe(mainSha)
    expect(verifyCalls[1]?.attempt).toBe(2)
    expect(verifyCalls[1]?.baseSha).not.toBe(mainSha)
    expect(verifyCalls[1]?.baseSha).not.toBe(verifyCalls[0]?.baseSha)
    // The second attempt's verify ran on a fresh rebase, so its tree differs
    // from the first attempt's — a stale pass from attempt 1 could never
    // carry over.
    expect(verifyCalls[1]?.taskSha).not.toBe(verifyCalls[0]?.taskSha)

    // What actually landed on main is exactly the sha the second (successful)
    // verify call passed — the exact `verifiedSha` produced by the preceding
    // verify, never an earlier or later tree.
    expect(git('rev-parse', 'main')).toBe(verifyCalls[1]?.taskSha)

    // Both the concurrently-injected commit and the task branch's own commit
    // are present on main — the redo genuinely re-rebased onto the new base
    // rather than clobbering it.
    expect(existsSync(resolve(repoDir, 'c.txt'))).toBe(true)
    expect(existsSync(resolve(repoDir, 'b.txt'))).toBe(true)

    // Lock released.
    expect(existsSync(resolve(getStateDir(), '.merge.lock'))).toBe(false)
  })

  it('fails with a bounded, classifiable reason instead of retrying forever when main keeps advancing', async () => {
    // Advance main on every single call — the redo budget must exhaust rather
    // than spin, and the failure must be distinguishable from an internal
    // crash (mergeBranch resolves, it does not throw).
    let counter = 0

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
      onBeforeFastForward: async (): Promise<void> => {
        counter += 1
        commitFile(`churn-${counter}.txt`, String(counter), `churn ${counter}`)
      },
    })

    expect(result.merged).toBe(false)
    expect(result.aborted).toBe(true)
    // Every negative outcome names why — the merge worker fails closed on a
    // reasonless `merged: false`.
    expect(result.reason).toBe('integration-advanced')
    // The redo budget is bounded: mergeBranch neither hangs nor spins past a
    // small, fixed number of attempts.
    expect(result.retriesAttempted).toBeGreaterThan(0)
    expect(result.retriesAttempted).toBeLessThan(10)
    // A classifiable reason is present in the output rather than a bare
    // internal error — this is what lets the failure-signature classifier
    // (errorClassRules in failure-signature.ts) name it instead of falling
    // through to `unclassified`.
    expect(result.output).toMatch(/integration moved during merge|is not an ancestor of/i)

    expect(existsSync(resolve(getStateDir(), '.merge.lock'))).toBe(false)
  })
})
