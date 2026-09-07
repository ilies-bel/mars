/**
 * Regression test for the 2026-09-07 data-loss incident:
 *
 *   `autoCommitOperatorDirt` silently reverted a previously merged feature
 *   because the integration checkout was left stale — the last-synced sha
 *   (baseSha) pointed past a merge whose `reset --hard` had not actually
 *   landed in the working tree.
 *
 * Shape reproduced here:
 *   1. Merge A lands new files into main (42ec44e8d shape).
 *   2. The checkout's working tree is left at the pre-merge state (sha_prev)
 *      — the reset that was supposed to bring the tree to sha_A was reverted
 *      by an integration-gate failure or a crash.
 *   3. baseSha (the recorded last-synced sha) is sha_A — it advanced past
 *      the missed reset.
 *   4. Merge B (unrelated files) triggers `autoCommitOperatorDirt` with
 *      baseSha=sha_A and working tree at sha_prev.
 *
 * Without the staleness guard, `diff(sha_A, working_tree)` shows sha_A's new
 * files as "deleted" by the operator, and the auto-commit produces a commit
 * that removes them — a silent revert.  The guard must detect this and
 * decline with `committed: false`.
 *
 * Also tests that mergeBranch correctly updates the recorded last-synced sha
 * when the integration gate fails and reverts the working-tree reset — so
 * the sha can never advance past the actual tree state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { autoCommitOperatorDirt } from '../operator-auto-commit'
import { mergeBranch } from '../merge'
import { readLastSyncedSha, writeLastSyncedSha } from '../last-synced-sha'
import { nullTraceStore } from '../../run-tool'
import { __resetContextCacheForTests } from '../../../context'

const TASK_ID = 'mars-stale-checkout-test'

let repoDir: string
let prevMarsRepo: string | undefined

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()

const gitProbe = (...args: string[]): { stdout: string; exitCode: number } => {
  try {
    const stdout = execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()
    return { stdout, exitCode: 0 }
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; status?: number }
    return { stdout: (e.stdout ?? '').toString().trim(), exitCode: e.status ?? 1 }
  }
}

const commitFile = (name: string, contents: string, message: string): void => {
  writeFileSync(resolve(repoDir, name), contents)
  git('add', name)
  git('commit', '-m', message)
}

beforeEach(() => {
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-stale-checkout-'))
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')
})

afterEach(() => {
  if (prevMarsRepo === undefined) delete process.env.MARS_REPO
  else process.env.MARS_REPO = prevMarsRepo
  __resetContextCacheForTests()
  rmSync(repoDir, { recursive: true, force: true })
})

describe('autoCommitOperatorDirt — staleness guard', () => {
  it(
    'declines when working tree is stale at an ancestor of baseSha (incident shape: new files not in tree)',
    async () => {
      // Step 1: sha_prev — base state.
      commitFile('existing.txt', 'initial content', 'c0: base')
      const shaPrev = git('rev-parse', 'HEAD')

      // Step 2: sha_A — Merge A lands 7 new files (the bulk-retry feature shape).
      // These files are committed into the repo object store via a normal commit
      // so all the blobs exist; the bug manifests regardless of how they got there.
      for (let i = 1; i <= 7; i++) {
        writeFileSync(resolve(repoDir, `feature-file-${i}.ts`), `export const f${i} = ${i}`)
        git('add', `feature-file-${i}.ts`)
      }
      git('commit', '-m', 'feat: add 7 feature files (merge A)')
      const shaA = git('rev-parse', 'HEAD')

      // Step 3: sha_B — Merge B lands an unrelated file (the restart guard fix).
      commitFile('b.txt', 'restart guard fix', 'fix: restart guard (merge B)')
      const shaB = git('rev-parse', 'HEAD')

      // Step 4: simulate the stale-checkout state.
      // The primary checkout's working tree is reset to shaPrev (as if the
      // reset --hard sha_A was reverted by an integration-gate failure), but
      // the recorded last-synced sha is sha_A (it was written before the revert).
      //
      // Use git reset --hard shaPrev to put the working tree and index back to
      // sha_prev, then force refs/heads/main to sha_B (the ref was advanced by
      // the merges but the tree was never resynced).
      execFileSync('git', ['reset', '--hard', shaPrev], { cwd: repoDir })
      execFileSync('git', ['update-ref', 'refs/heads/main', shaB], { cwd: repoDir })
      // Verify setup: the 7 files must NOT be in the working tree.
      expect(existsSync(resolve(repoDir, 'feature-file-1.ts'))).toBe(false)
      // The feature files ARE in the sha_A tree (they exist as objects).
      expect(gitProbe('show', `${shaA}:feature-file-1.ts`).exitCode).toBe(0)

      // Step 5: call autoCommitOperatorDirt as mergeBranch would, with
      // baseSha=shaA (the stale last-synced sha) and headSha=shaB.
      const result = await autoCommitOperatorDirt({
        repoRoot: repoDir,
        taskId: TASK_ID,
        baseSha: shaA,   // stale: sha_A is recorded but tree is at sha_prev
        headSha: shaB,
      })

      // The guard must decline — not produce a commit that deletes the 7 files.
      expect(result.committed).toBe(false)
      if (!result.committed) {
        expect(result.reason).toMatch(/integration checkout is out of sync/i)
        expect(result.reason).toContain(shaA.slice(0, 9))
      }

      // No new commit must have been produced (main still points to shaB, not
      // some new commit on top of it that deletes the 7 feature files).
      expect(git('rev-parse', 'main')).toBe(shaB)

      // The 7 feature files must still exist in sha_A's tree (not deleted from history).
      for (let i = 1; i <= 7; i++) {
        expect(gitProbe('show', `${shaA}:feature-file-${i}.ts`).exitCode).toBe(0)
      }
      // And sha_B must still have all 7 feature files (no revert commit created).
      for (let i = 1; i <= 7; i++) {
        expect(gitProbe('show', `${shaB}:feature-file-${i}.ts`).exitCode).toBe(0)
      }
    },
    60_000,
  )

  it(
    'does NOT decline when the working tree has genuine operator edits relative to baseSha',
    async () => {
      // Base + task commit.
      commitFile('existing.txt', 'initial', 'c0')
      commitFile('b.txt', 'merged by task', 'task commit')
      const shaA = git('rev-parse', 'HEAD')

      // Operator edits existing.txt after sha_A.
      writeFileSync(resolve(repoDir, 'existing.txt'), 'OPERATOR EDIT')

      // This is genuine operator dirt — should be auto-committed, not declined.
      const result = await autoCommitOperatorDirt({
        repoRoot: repoDir,
        taskId: TASK_ID,
        baseSha: shaA,
        headSha: shaA, // headSha same as baseSha for simplicity
      })

      // Should commit (or return a non-staleness reason like contested path).
      // The staleness guard must NOT fire for genuine operator changes.
      if (!result.committed) {
        expect(result.reason).not.toMatch(/integration checkout is out of sync/i)
      }
    },
    60_000,
  )
})

describe('mergeBranch — integration-gate failure reverts writeLastSyncedSha', () => {
  it(
    'does not leave last-synced sha ahead of the working tree after an integration-gate failure',
    async () => {
      // Set up: main with a tracked file, task branch adds b.txt.
      commitFile('a.txt', 'base', 'c0: base')
      const c0 = git('rev-parse', 'HEAD')

      git('branch', 'task/gate-fail')
      const worktreeDir = resolve(repoDir, '..', `${repoDir.split('/').pop() ?? 'wt'}-gate-wt`)
      git('worktree', 'add', worktreeDir, 'task/gate-fail')
      try {
        execFileSync('git', ['config', 'user.email', 'test@mars.local'], { cwd: worktreeDir })
        execFileSync('git', ['config', 'user.name', 'Mars Test'], { cwd: worktreeDir })
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: worktreeDir })

        // Task commit adds b.txt.
        writeFileSync(resolve(worktreeDir, 'b.txt'), 'task content')
        execFileSync('git', ['add', 'b.txt'], { cwd: worktreeDir })
        execFileSync('git', ['commit', '-m', 'feat: add b.txt'], { cwd: worktreeDir })
        const taskSha = execFileSync('git', ['rev-parse', 'task/gate-fail'], {
          cwd: repoDir,
          encoding: 'utf8',
        }).trim()

        // Seed the last-synced sha with c0 so Step 3's clean-tree path applies.
        writeLastSyncedSha(c0, repoDir)

        // Trigger mergeBranch with an integration gate that always fails.
        // This exercises the path where: Step 3 resets to taskSha and writes
        // writeLastSyncedSha(taskSha), then the gate fails, then we roll back.
        const result = await mergeBranch({
          branch: 'task/gate-fail',
          worktreePath: worktreeDir,
          integrationBranch: 'main',
          lockTimeoutMs: 30_000,
          autoCommitOperatorDirt: false,
          onAfterFastForward: async () => {
            throw new Error('integration gate rejected')
          },
          traceCtx: { taskId: TASK_ID, store: nullTraceStore },
        })

        // The merge should report failure (gate rejected it).
        expect(result.merged).toBe(false)
        expect(result.integrationGateFailed).toBe(true)

        // refs/heads/main must be reverted to c0 (the pre-merge sha).
        expect(git('rev-parse', 'main')).toBe(c0)

        // The recorded last-synced sha must NOT be taskSha (which was written
        // by Step 3 before the gate ran). It must be back at c0 so a subsequent
        // merge's stale-tree attribution is correct.
        const recorded = readLastSyncedSha(repoDir)
        expect(recorded).toBe(c0)
        expect(recorded).not.toBe(taskSha)
      } finally {
        rmSync(worktreeDir, { recursive: true, force: true })
        try {
          execFileSync('git', ['worktree', 'prune'], { cwd: repoDir })
        } catch {
          // best-effort
        }
      }
    },
    60_000,
  )
})
