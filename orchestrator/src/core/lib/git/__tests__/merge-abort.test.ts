/**
 * Watchdog / cancellation tests for `mergeBranch`.
 *
 * The git primitive layer (`./internal`) is mocked so a merge can be made to
 * hang: every non-cleanup git spawn returns a promise that only settles when
 * its forwarded AbortSignal fires. That leaves the internal watchdog timer as
 * the sole thing that can unblock the merge — exactly the wedged-primitive
 * scenario the watchdog exists to bound.
 *
 * We assert that:
 *   - the watchdog fires within 1.5× the configured `watchdogMs`, and
 *   - `mergeBranch` rejects with a `MergeAbortedError` whose `reason` is
 *     `'watchdog'` and whose `lastStep` is populated.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// A promise that never resolves; it rejects only when its AbortSignal fires.
// Simulates a git child process that hangs until it is killed on abort.
const hangUntilAbort = (opts: {
  signal?: AbortSignal
}): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
  new Promise((_resolve, reject) => {
    const sig = opts?.signal
    // Every mergeBranch git call forwards the combined signal, so this branch
    // is always taken in practice; guard defensively regardless.
    if (!sig) return
    if (sig.aborted) {
      reject(new Error('git child aborted'))
      return
    }
    sig.addEventListener(
      'abort',
      () => reject(new Error('git child aborted')),
      { once: true },
    )
  })

vi.mock('../internal', async (importActual) => {
  const actual = await importActual<typeof import('../internal')>()
  return {
    ...actual,
    // Non-cleanup calls hang until aborted; the `--abort` cleanup calls
    // (run bounded, off the aborted signal) resolve immediately so the abort
    // teardown path can complete.
    exec: vi.fn(
      (
        _cmd: string,
        args: readonly string[],
        opts: { signal?: AbortSignal },
      ) => {
        if (args.includes('--abort')) {
          return Promise.resolve({ stdout: '', stderr: '' })
        }
        return hangUntilAbort(opts)
      },
    ),
    execProbe: vi.fn(
      (
        _cmd: string,
        args: readonly string[],
        opts: { signal?: AbortSignal },
      ) => {
        if (args.includes('--abort')) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
        }
        return hangUntilAbort(opts)
      },
    ),
  }
})

// Imported AFTER vi.mock so merge.ts binds to the mocked primitives.
import { mergeBranch, MergeAbortedError } from '../merge'

let repoDir: string
let prevMarsRepo: string | undefined

beforeAll(() => {
  // getStateDir()/repoRoot() resolve off MARS_REPO; the real acquireLock writes
  // a lock file under <repo>/.mars, so point it at a throwaway temp dir.
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-abort-'))
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
})

afterAll(() => {
  if (prevMarsRepo !== undefined) {
    process.env.MARS_REPO = prevMarsRepo
  } else {
    delete process.env.MARS_REPO
  }
  rmSync(repoDir, { recursive: true, force: true })
})

describe('mergeBranch — watchdog', () => {
  it('aborts a hanging merge within 1.5× the watchdog budget and rejects with MergeAbortedError(reason: watchdog)', async () => {
    const watchdogMs = 100
    const start = Date.now()

    const err: unknown = await mergeBranch({
      branch: 'task/feat',
      worktreePath: repoDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
      watchdogMs,
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
    expect(aborted.elapsedMs).toBeGreaterThanOrEqual(0)

    // The watchdog must fire promptly — well within 1.5× the configured budget.
    expect(elapsedMs).toBeLessThan(watchdogMs * 1.5)
  })
})
