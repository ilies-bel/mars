/**
 * Regression test for the merge-lock deadlock: a hanging callback inside the
 * lock-held merge body (simulating a DB call that never resolves after a TCP
 * reset) must not hold `.merge.lock` indefinitely.
 *
 * Before the fix: the watchdog fired → git subprocesses were killed via
 * `combinedSignal`, but a hanging callback await never settled → the inner
 * `finally { release() }` never ran → the lock was held forever.
 *
 * After the fix: `Promise.race([mergeBody(), abortPromise])` ensures that when
 * `combinedSignal` aborts (watchdog or external signal), `abortPromise` rejects,
 * `Promise.race` settles, the inner `finally` always runs and releases the lock,
 * and the outer catch produces `MergeAbortedError(reason: 'watchdog')`.
 *
 * We use the `onBeforeFastForward` TEST-ONLY seam (called inside the
 * lock-held body before the CAS fast-forward) as a stand-in for any
 * hanging callback — it hangs on a never-resolving Promise, which is
 * behaviourally identical to a DB call that stalls after a connection reset.
 *
 * A real git repo is used to drive the merge body to the `onBeforeFastForward`
 * callsite without mocking git internals. The test timeout (10 s) would trip
 * if the lock were held beyond the watchdog budget.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { mergeBranch, MergeAbortedError } from '../merge'
import { __resetContextCacheForTests } from '../../../context'

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
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-callback-hang-'))
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')

  // c1 on main; branch task/feat off c1, add c2 so it is 1 commit ahead.
  commitFile('a.txt', 'a', 'c1')
  git('branch', 'task/feat')
  git('checkout', 'task/feat')
  commitFile('b.txt', 'b', 'c2')
  git('checkout', 'main')

  // Sanity: task/feat is exactly 1 commit ahead of main.
  const ahead = git('rev-list', '--count', 'main..task/feat')
  if (ahead !== '1') throw new Error(`unexpected ahead count: ${ahead}`)
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

describe('mergeBranch — callback-hang watchdog', () => {
  it(
    'releases the lock and rejects with MergeAbortedError(watchdog) when onBeforeFastForward hangs',
    async () => {
      const watchdogMs = 300 // short for test speed

      // A never-resolving promise simulates a DB call that hangs after a TCP
      // reset (pg "unexpected EOF on client connection with an open transaction").
      // onBeforeFastForward is called inside the lock-held body, making it a
      // direct stand-in for onVegaStart / onAfterFastForward DB calls.
      const hangForever = new Promise<void>(() => {
        // intentionally never resolves or rejects
      })

      const start = Date.now()
      const err: unknown = await mergeBranch({
        branch: 'task/feat',
        worktreePath: repoDir,
        integrationBranch: 'main',
        lockTimeoutMs: 5_000,
        watchdogMs,
        onBeforeFastForward: () => hangForever,
      }).then(
        () => {
          throw new Error('expected mergeBranch to reject, but it resolved')
        },
        (e: unknown) => e,
      )

      const elapsedMs = Date.now() - start

      expect(err).toBeInstanceOf(MergeAbortedError)
      const aborted = err as MergeAbortedError
      expect(aborted.reason).toBe('watchdog')
      expect(typeof aborted.lastStep).toBe('string')
      expect(aborted.lastStep.length).toBeGreaterThan(0)

      // The watchdog must fire within a generous window. 5× the budget gives
      // headroom for parallel-test system load without masking real hangs
      // (a broken implementation would hang for lockTimeoutMs = 5000ms, not 1500ms).
      expect(elapsedMs).toBeLessThan(watchdogMs * 5)

      // Verify the lock has been released: a second mergeBranch call with a
      // short lockTimeoutMs should fail for a reason OTHER than lock-timeout.
      // If the first call left the lock held, this would fail with a lock error.
      const lockReleasedResult: unknown = await mergeBranch({
        branch: 'task/feat',
        worktreePath: repoDir,
        integrationBranch: 'main',
        lockTimeoutMs: 1_000, // fast: if the lock is still held this times out
        watchdogMs: 5_000,
      }).then(
        (r) => r,
        (e: unknown) => e,
      )

      // The call must NOT fail with a lock-acquisition timeout.
      const lockTimeoutMsg = 'Failed to acquire merge lock after'
      if (lockReleasedResult instanceof Error) {
        expect(lockReleasedResult.message).not.toContain(lockTimeoutMsg)
      }
    },
    10_000,
  )
})
