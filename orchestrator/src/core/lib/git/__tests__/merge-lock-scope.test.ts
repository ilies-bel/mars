/**
 * ADR-0100 step 4 (slice 8): `.merge.lock` must be held only across the CAS
 * fast-forward — not across the two expensive phases that precede it inside
 * one `mergeBranch` attempt: the rebase and the full verify of the rebased
 * tree (`onVerifyRebasedTree`). Holding the lock across either of those would
 * let one slow verify stall every other concurrently-merging task, which is
 * exactly what step 2 (lazy lock acquisition) moved off the hot path.
 *
 * This test wraps the REAL `acquireLock` (from `../lock`) so every genuine
 * acquire/release is recorded into a shared, ordered timeline, and uses
 * `mergeBranch`'s own `onPhase` reporter to tag the 'rebase' and
 * 'verify-rebased-tree' sub-phases into the same timeline (the 'fast-forward'
 * phase IS the CAS: it fires immediately before the `update-ref <ref> <new>
 * <old>` call — see the comment above that call site in ../merge.ts). No git
 * primitive is faked: rebase, verify and the CAS all run for real against a
 * throwaway repo + linked worktree, exactly like ../merge-cas-redo.test.ts.
 *
 * Three shapes are asserted:
 *   1. A single, uncontested merge: one acquire/CAS/release triple, with the
 *      rebase and verify events strictly outside that window.
 *   2. The mismatch-redo path (a concurrent commit lands on integration
 *      between this attempt's verify and its CAS, exactly as in
 *      ../merge-cas-redo.test.ts): two full acquire/CAS/release triples, one
 *      per attempt, each still excluding its own rebase+verify.
 *   3. The throw path: an exception raised at the CAS boundary still leaves
 *      the lock released (via mergeBranch's outer `finally`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

type ScopeEventTag = 'acquire' | 'release' | 'rebase-start' | 'verify-start' | 'cas'

const { events } = vi.hoisted(() => ({
  events: [] as ScopeEventTag[],
}))

// Wrap the real acquireLock so every genuine lock acquisition/release is
// recorded, in the exact order it happens, into the shared `events`
// timeline. The underlying lock primitive (file-based mutual exclusion) is
// untouched — this only observes it.
vi.mock('../lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lock')>()
  return {
    ...actual,
    acquireLock: async (
      ...args: Parameters<typeof actual.acquireLock>
    ): ReturnType<typeof actual.acquireLock> => {
      const release = await actual.acquireLock(...args)
      events.push('acquire')
      return async () => {
        await release()
        events.push('release')
      }
    },
  }
})

// Imported AFTER vi.mock so mergeBranch binds to the wrapped acquireLock.
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
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-lock-scope-'))
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
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()
  // Rewind both refs so each test starts from the same diverged shape.
  git('reset', '--hard', mainSha)
  gitIn(worktreeDir, 'reset', '--hard', featSha)
  events.length = 0
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

/**
 * A phase reporter that tags the three sub-phases we care about into the
 * shared `events` timeline, using the same phase-name vocabulary mergeBranch
 * itself emits via `onPhase` (see `MergeArgs.onPhase` in ../merge.ts):
 * 'rebase', 'verify-rebased-tree', 'fast-forward'. `fast-forward` IS the CAS —
 * it fires immediately before the `update-ref <ref> <new> <old>` call that
 * atomically lands (or rejects) the fast-forward.
 */
const onPhase = (phase: string): void => {
  if (phase === 'rebase') events.push('rebase-start')
  if (phase === 'verify-rebased-tree') events.push('verify-start')
  if (phase === 'fast-forward') events.push('cas')
}

const alwaysPass = async (): Promise<MergeGateOutcome> => ({ passed: true })

/**
 * Index-based check: every 'acquire' has a later matching 'release' (the
 * lock is never left dangling), and no 'rebase-start' / 'verify-start' event
 * index falls strictly inside any [acquireIdx, releaseIdx) window — i.e. the
 * two expensive phases never run while the lock is held.
 */
const assertRebaseAndVerifyOutsideLock = (): void => {
  const acquireIdxs: number[] = []
  const releaseIdxs: number[] = []
  events.forEach((e, i) => {
    if (e === 'acquire') acquireIdxs.push(i)
    if (e === 'release') releaseIdxs.push(i)
  })
  expect(acquireIdxs.length).toBe(releaseIdxs.length)
  const windows = acquireIdxs.map((a, i) => [a, releaseIdxs[i]] as const)
  windows.forEach(([a, r]) => expect(a).toBeLessThan(r))

  events.forEach((e, idx) => {
    if (e !== 'rebase-start' && e !== 'verify-start') return
    const insideAnyWindow = windows.some(([a, r]) => idx > a && idx < r)
    expect(insideAnyWindow).toBe(false)
  })
}

describe('mergeBranch — .merge.lock scope excludes rebase and verify', () => {
  it('acquires the lock only around the CAS, with rebase+verify recorded outside it', async () => {
    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
      onVerifyRebasedTree: alwaysPass,
      onPhase,
    })

    expect(result.merged).toBe(true)
    expect(result.aborted).toBe(false)

    // Exact ordering for the single, uncontested attempt: rebase and verify
    // both complete before the lock is ever touched.
    expect(events).toEqual(['rebase-start', 'verify-start', 'acquire', 'cas', 'release'])
    assertRebaseAndVerifyOutsideLock()

    expect(events.filter((e) => e === 'acquire')).toHaveLength(1)
    expect(events.filter((e) => e === 'cas')).toHaveLength(1)
    expect(events.filter((e) => e === 'release')).toHaveLength(1)

    expect(existsSync(resolve(getStateDir(), '.merge.lock'))).toBe(false)
  })

  it('re-acquires and releases the lock once per attempt on the mismatch-redo path', async () => {
    let injected = false

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
      onVerifyRebasedTree: alwaysPass,
      onPhase,
      // TEST-ONLY seam: fires inside the lock, immediately before the CAS
      // update-ref. On the first call only, commit directly onto `main` —
      // simulating a concurrent merge landing between this attempt's verify
      // and its CAS, the exact race the redo path exists to handle (mirrors
      // ../merge-cas-redo.test.ts).
      onBeforeFastForward: async (): Promise<void> => {
        if (injected) return
        injected = true
        commitFile('c.txt', 'c', 'c3: concurrent advance of main')
      },
    })

    expect(result.merged).toBe(true)
    expect(result.retriesAttempted).toBe(1)

    // Two full attempts, each acquiring/releasing the lock exactly once
    // around its own CAS — the rejected first CAS releases before the redo's
    // rebase+verify run, not after.
    expect(events).toEqual([
      'rebase-start',
      'verify-start',
      'acquire',
      'cas',
      'release',
      'rebase-start',
      'verify-start',
      'acquire',
      'cas',
      'release',
    ])
    assertRebaseAndVerifyOutsideLock()

    expect(events.filter((e) => e === 'acquire')).toHaveLength(2)
    expect(events.filter((e) => e === 'cas')).toHaveLength(2)
    expect(events.filter((e) => e === 'release')).toHaveLength(2)

    expect(existsSync(resolve(getStateDir(), '.merge.lock'))).toBe(false)
  })

  it('releases the lock even when an exception is thrown at the CAS boundary', async () => {
    const boom = new Error('boom: exception during CAS')

    await expect(
      mergeBranch({
        branch: 'task/feat',
        worktreePath: worktreeDir,
        integrationBranch: 'main',
        lockTimeoutMs: 5_000,
        onVerifyRebasedTree: alwaysPass,
        onPhase,
        // Fires inside the lock, immediately before the CAS update-ref —
        // throwing here simulates an exception during the CAS itself. It
        // pre-empts the 'cas' tag (which fires just after this resolves), so
        // it never appears in `events` below.
        onBeforeFastForward: async (): Promise<void> => {
          throw boom
        },
      }),
    ).rejects.toBe(boom)

    // The lock was acquired (rebase+verify already ran) but the thrown
    // exception must still result in a release via mergeBranch's outer
    // `finally`, not a dangling lock.
    expect(events).toEqual(['rebase-start', 'verify-start', 'acquire', 'release'])
    assertRebaseAndVerifyOutsideLock()

    expect(existsSync(resolve(getStateDir(), '.merge.lock'))).toBe(false)
  })
})
