/**
 * ADR-0100 step 2: the full verify runs on the REBASED tree, in the task's own
 * worktree, BEFORE the merge lock is taken.
 *
 * Before this slice the integration gate ran inside `.merge.lock`, after the
 * fast-forward — so the tree that was tested was not the tree that landed, and
 * a full test suite held the lock for its whole duration. Now `mergeBranch`
 * calls `onVerifyRebasedTree` immediately after `git rebase <integration>`
 * completes and before `acquireLock`, hands it the post-rebase task-branch sha,
 * and only fast-forwards to that exact sha.
 *
 * The task branch lives in a real linked git worktree (not the primary
 * checkout) so the rebase genuinely moves its tip — that is what makes
 * "verified sha != pre-merge sha" a meaningful assertion rather than a
 * tautology on a no-op rebase.
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
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-rebased-verify-'))
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

  // main: c1. task/feat branches at c1 and adds c2. main then advances to c3,
  // so the branch is genuinely behind and `git rebase main` must move its tip.
  commitFile('a.txt', 'a', 'c1')
  git('branch', 'task/feat')
  git('worktree', 'add', '--quiet', worktreeDir, 'task/feat')
  writeFileSync(resolve(worktreeDir, 'b.txt'), 'b')
  gitIn(worktreeDir, 'add', 'b.txt')
  gitIn(worktreeDir, 'commit', '-m', 'c2')
  commitFile('c.txt', 'c', 'c3')

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

describe('mergeBranch — verify runs on the rebased tree, outside the lock', () => {
  it('calls the gate with the post-rebase worktree sha while the merge lock is not held, then lands exactly that sha', async () => {
    const calls: Array<{
      baseSha: string
      taskSha: string
      attempt: number
      lockHeld: boolean
      worktreeHeadSha: string
      worktreeHasMainCommit: boolean
    }> = []

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
      onVerifyRebasedTree: async (info): Promise<MergeGateOutcome> => {
        calls.push({
          ...info,
          lockHeld: existsSync(resolve(getStateDir(), '.merge.lock')),
          worktreeHeadSha: gitIn(worktreeDir, 'rev-parse', 'HEAD'),
          // main's c3 file only exists in the worktree once the rebase landed.
          worktreeHasMainCommit: existsSync(resolve(worktreeDir, 'c.txt')),
        })
        return { passed: true }
      },
    })

    expect(result.merged).toBe(true)
    expect(calls).toHaveLength(1)
    const call = calls[0]

    // The lock was NOT held while the verify ran.
    expect(call.lockHeld).toBe(false)

    // The gate ran on the rebased tree in the task's own worktree: the sha it
    // was handed is the worktree's HEAD, it is not the pre-merge branch tip,
    // and main's newest commit is present in that worktree.
    expect(call.taskSha).toBe(call.worktreeHeadSha)
    expect(call.taskSha).not.toBe(featSha)
    expect(call.worktreeHasMainCommit).toBe(true)
    expect(call.baseSha).toBe(mainSha)
    expect(call.attempt).toBe(1)

    // The verified sha is what fast-forwarded — the tree that was tested is
    // byte-for-byte the tree that landed.
    expect(git('rev-parse', 'main')).toBe(call.taskSha)

    // And the lock was released again afterwards.
    expect(existsSync(resolve(getStateDir(), '.merge.lock'))).toBe(false)
  })

  it('aborts the merge with rebased-verify-failed and leaves main untouched when the gate rejects', async () => {
    const verifyOutput = 'FAIL src/thing.test.ts > composes with main'
    let lockHeldDuringCall: boolean | null = null

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
      onVerifyRebasedTree: async (): Promise<MergeGateOutcome> => {
        lockHeldDuringCall = existsSync(resolve(getStateDir(), '.merge.lock'))
        return { passed: false, output: verifyOutput }
      },
    })

    expect(lockHeldDuringCall).toBe(false)
    expect(result.merged).toBe(false)
    expect(result.reason).toBe('rebased-verify-failed')
    expect(result.rebasedVerifyOutput).toBe(verifyOutput)

    // Nothing was fast-forwarded: main is still where it was.
    expect(git('rev-parse', 'main')).toBe(mainSha)
    expect(existsSync(resolve(getStateDir(), '.merge.lock'))).toBe(false)
  })

  it('skips the gate entirely when no onVerifyRebasedTree is supplied', async () => {
    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
    })

    expect(result.merged).toBe(true)
    expect(result.reason).toBeUndefined()
    expect(git('rev-parse', 'main')).toBe(gitIn(worktreeDir, 'rev-parse', 'HEAD'))
  })
})
