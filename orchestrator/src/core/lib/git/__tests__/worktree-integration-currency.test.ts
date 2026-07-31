/**
 * Regression: a restarted task must not re-run against stale code.
 *
 * THE BUG. `mars restart` removes the worktree directory but deliberately
 * PRESERVES `task/<id>` whenever the branch carries unmerged commits — deleting
 * it would destroy the failed attempt's work (see `coreRestartTask`'s
 * commits-ahead guard). The next dispatch then reaches `createWorktree`, which
 * takes the `branchAlreadyExists` path and runs
 *
 *     git worktree add <path> <branch>
 *
 * checking the branch out AT ITS OLD TIP instead of branching off the
 * integration tip. Measured on the live repo: three worktrees 46, 89 and 89
 * commits behind `main`. `verify` then ran against superseded source and failed
 * the exact assertions `main` had already fixed, so restarting the task could
 * never make it drain.
 *
 * These tests drive real git in a temp repo. `syncWorktreeToIntegration` is the
 * fix; the primitives call it from `setupWorktree` (before deps install) and
 * from `runAgent`'s preflight (the only pre-`code` hook on a checkpoint-resume).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

let repoRoot: string
const originalRepoEnv = process.env.MARS_REPO

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

/** Commits ahead of `base` on `ref`, as git sees them. */
const countAhead = (base: string, ref: string): number =>
  Number.parseInt(git(['rev-list', '--count', `${base}..${ref}`], repoRoot).trim(), 10)

const isAncestor = (a: string, b: string, cwd: string): boolean => {
  try {
    git(['merge-base', '--is-ancestor', a, b], cwd)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  repoRoot = mkdtempSync(resolve(tmpdir(), 'mars-currency-repo-'))
  git(['init', '-b', 'main'], repoRoot)
  git(['config', 'user.email', 'test@mars'], repoRoot)
  git(['config', 'user.name', 'Mars Test'], repoRoot)
  writeFileSync(resolve(repoRoot, 'shared.txt'), 'base\n')
  writeFileSync(resolve(repoRoot, 'app.ts'), 'export const app = 1\n')
  git(['add', 'shared.txt', 'app.ts'], repoRoot)
  git(['commit', '-m', 'base'], repoRoot)

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

/**
 * Reproduce the exact live sequence: a task branch is created, its coder
 * commits, the task fails, `main` moves on (a test fix lands), then restart
 * removes the worktree, preserves the branch, and setup re-attaches it.
 *
 * @returns the re-attached worktree path + branch, exactly what `createWorktree`
 *          hands the rest of the pipeline.
 */
const stageRestartedTaskOnStaleBranch = async (opts: {
  taskId: string
  /** Extra commits landed on `main` after the task branch forked. */
  mainCommits: number
  /** When true, the task's commit touches the same file `main` changed. */
  conflicting?: boolean
}): Promise<{ path: string; branch: string }> => {
  const { createWorktree } = await import('../worktree')
  const branch = `task/${opts.taskId}`
  const worktreePath = resolve(repoRoot, `.mars/worktrees/${opts.taskId}`)
  mkdirSync(resolve(worktreePath, '..'), { recursive: true })

  // 1. setup carves the worktree off main and the coder commits into it.
  await createWorktree({ taskId: opts.taskId, integrationBranch: 'main' })
  if (opts.conflicting === true) {
    writeFileSync(resolve(worktreePath, 'shared.txt'), `coder version ${opts.taskId}\n`)
    git(['add', 'shared.txt'], worktreePath)
  } else {
    writeFileSync(resolve(worktreePath, 'feature.ts'), 'export const feature = 1\n')
    git(['add', 'feature.ts'], worktreePath)
  }
  git(['commit', '-m', 'chore(auto-commit): coder finished but did not commit'], worktreePath)

  // 2. The task fails verify. Meanwhile main advances — including the very fix
  //    the task's verify needs.
  for (let i = 0; i < opts.mainCommits; i++) {
    // Content must be unique per (task, step): if a later task's advance
    // restored a byte-identical shared.txt, the rebase would apply cleanly and
    // the conflict fixture would silently stop conflicting.
    writeFileSync(
      resolve(repoRoot, 'shared.txt'),
      opts.conflicting === true
        ? `main version ${opts.taskId} ${i}\n`
        : `base\nmain change ${i}\n`,
    )
    git(['add', 'shared.txt'], repoRoot)
    git(['commit', '-m', `fix(tests): landed on main #${i}`], repoRoot)
  }

  // 3. `mars restart` removes the worktree but PRESERVES the branch, because it
  //    is ahead of main (coreRestartTask's commits-ahead guard).
  git(['worktree', 'remove', '--force', worktreePath], repoRoot)
  expect(existsSync(worktreePath)).toBe(false)
  expect(countAhead('main', branch)).toBeGreaterThan(0)

  // 4. The next dispatch runs setup again. This is the code under test's input.
  const ref = await createWorktree({ taskId: opts.taskId, integrationBranch: 'main' })
  return ref
}

describe('syncWorktreeToIntegration — a restarted task must see current code', () => {
  it('reproduces the defect: setup re-attaches the preserved branch at its OLD tip', async () => {
    const ref = await stageRestartedTaskOnStaleBranch({
      taskId: 'mars-stale01',
      mainCommits: 3,
    })

    // This is the bug, stated as an assertion: the freshly "set up" worktree is
    // behind main, and the fix that landed on main is simply not in the tree.
    expect(countAhead(ref.branch, 'main')).toBe(3)
    expect(readFileSync(resolve(ref.path, 'shared.txt'), 'utf-8')).toBe('base\n')
    expect(isAncestor('main', 'HEAD', ref.path)).toBe(false)
  })

  it('brings the restarted worktree up to date BEFORE code runs', async () => {
    const { syncWorktreeToIntegration } = await import('../worktree')
    const ref = await stageRestartedTaskOnStaleBranch({
      taskId: 'mars-stale02',
      mainCommits: 3,
    })
    const mainSha = git(['rev-parse', 'main'], repoRoot).trim()

    const outcome = await syncWorktreeToIntegration({
      taskId: 'mars-stale02',
      ref,
      integrationBranch: 'main',
    })

    expect(outcome.kind).toBe('rebased')
    // The integration tip is now contained in the worktree's HEAD...
    expect(isAncestor(mainSha, 'HEAD', ref.path)).toBe(true)
    expect(countAhead(ref.branch, 'main')).toBe(0)
    // ...and the file the fix touched holds main's content, not the stale copy.
    expect(readFileSync(resolve(ref.path, 'shared.txt'), 'utf-8')).toBe(
      'base\nmain change 2\n',
    )
  })

  it('preserves pre-existing COMMITTED work on the task branch', async () => {
    const { syncWorktreeToIntegration } = await import('../worktree')
    const ref = await stageRestartedTaskOnStaleBranch({
      taskId: 'mars-stale03',
      mainCommits: 3,
    })

    await syncWorktreeToIntegration({
      taskId: 'mars-stale03',
      ref,
      integrationBranch: 'main',
    })

    // The coder's commit is replayed on top of the new base: still exactly one
    // commit ahead of main, still carrying its file and its subject.
    expect(countAhead('main', ref.branch)).toBe(1)
    expect(git(['log', '-1', '--format=%s', ref.branch], repoRoot).trim()).toBe(
      'chore(auto-commit): coder finished but did not commit',
    )
    expect(readFileSync(resolve(ref.path, 'feature.ts'), 'utf-8')).toBe(
      'export const feature = 1\n',
    )
    // ...and the branch is now fast-forwardable, which is what the merge step
    // needs (mergeBranch asserts integration is an ancestor of the task tip).
    expect(isAncestor('main', ref.branch, repoRoot)).toBe(true)
  })

  it('preserves UNCOMMITTED work — parked on a per-task checkpoint ref, never the shared stash', async () => {
    const { syncWorktreeToIntegration } = await import('../worktree')
    const { CHECKPOINT_REF_PREFIX } = await import('../checkpoint')
    const ref = await stageRestartedTaskOnStaleBranch({
      taskId: 'mars-stale04',
      mainCommits: 2,
    })

    // Operator / prior-coder state left in the tree: a tracked edit plus an
    // untracked (non-ignored) file.
    writeFileSync(resolve(ref.path, 'app.ts'), 'export const app = 2 // wip\n')
    writeFileSync(resolve(ref.path, 'scratch.md'), 'wip notes\n')

    const outcome = await syncWorktreeToIntegration({
      taskId: 'mars-stale04',
      ref,
      integrationBranch: 'main',
    })

    expect(outcome.kind).toBe('rebased')
    // Both survive the rebase, in the worktree, still uncommitted.
    expect(readFileSync(resolve(ref.path, 'app.ts'), 'utf-8')).toBe(
      'export const app = 2 // wip\n',
    )
    expect(readFileSync(resolve(ref.path, 'scratch.md'), 'utf-8')).toBe('wip notes\n')
    expect(git(['status', '--porcelain'], ref.path)).toContain('app.ts')

    // And they were parked on this task's OWN ref — `refs/stash` is shared by
    // every linked worktree in a repo and is addressed by shifting positions,
    // so the orchestrator must never touch it.
    expect(outcome).toMatchObject({
      checkpointRef: `${CHECKPOINT_REF_PREFIX}/setup-mars-stale04`,
    })
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/stash'], repoRoot).trim()).toBe('')
  })

  it('is a cheap no-op on a freshly-carved worktree', async () => {
    const { createWorktree, syncWorktreeToIntegration } = await import('../worktree')
    mkdirSync(resolve(repoRoot, '.mars/worktrees'), { recursive: true })
    const ref = await createWorktree({ taskId: 'mars-fresh01', integrationBranch: 'main' })

    const outcome = await syncWorktreeToIntegration({
      taskId: 'mars-fresh01',
      ref,
      integrationBranch: 'main',
    })

    expect(outcome).toEqual({ kind: 'already-current' })
  })

  it('honours INTEGRATION_BRANCH rather than hardcoding main', async () => {
    const { createWorktree, syncWorktreeToIntegration } = await import('../worktree')
    mkdirSync(resolve(repoRoot, '.mars/worktrees'), { recursive: true })

    // A release branch that has moved on independently of main.
    git(['branch', 'release'], repoRoot)
    const ref = await createWorktree({ taskId: 'mars-rel01', integrationBranch: 'release' })
    writeFileSync(resolve(ref.path, 'feature.ts'), 'export const feature = 1\n')
    git(['add', 'feature.ts'], ref.path)
    git(['commit', '-m', 'work'], ref.path)

    git(['checkout', 'release'], repoRoot)
    writeFileSync(resolve(repoRoot, 'shared.txt'), 'release moved\n')
    git(['add', 'shared.txt'], repoRoot)
    git(['commit', '-m', 'release advance'], repoRoot)
    git(['checkout', 'main'], repoRoot)

    const outcome = await syncWorktreeToIntegration({
      taskId: 'mars-rel01',
      ref,
      integrationBranch: 'release',
    })

    expect(outcome.kind).toBe('rebased')
    expect(isAncestor('release', ref.branch, repoRoot)).toBe(true)
    // main is untouched — the sync followed the override, not the default.
    expect(readFileSync(resolve(ref.path, 'shared.txt'), 'utf-8')).toBe('release moved\n')
  })
})

describe('syncWorktreeToIntegration — conflict is escalated, never silently resolved', () => {
  it('aborts the rebase and leaves the worktree exactly as it was', async () => {
    const { syncWorktreeToIntegration, WorktreeRebaseConflictError } = await import(
      '../worktree'
    )
    const ref = await stageRestartedTaskOnStaleBranch({
      taskId: 'mars-conflict1',
      mainCommits: 2,
      conflicting: true,
    })
    const tipBefore = git(['rev-parse', ref.branch], repoRoot).trim()

    await expect(
      syncWorktreeToIntegration({
        taskId: 'mars-conflict1',
        ref,
        integrationBranch: 'main',
      }),
    ).rejects.toBeInstanceOf(WorktreeRebaseConflictError)

    // No half-rebased worktree: no rebase state on disk, HEAD back on the
    // branch at its original tip, tree clean, committed work untouched.
    expect(existsSync(resolve(repoRoot, `.git/worktrees/mars-conflict1/rebase-merge`))).toBe(
      false,
    )
    expect(existsSync(resolve(repoRoot, `.git/worktrees/mars-conflict1/rebase-apply`))).toBe(
      false,
    )
    expect(git(['rev-parse', ref.branch], repoRoot).trim()).toBe(tipBefore)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], ref.path).trim()).toBe(ref.branch)
    expect(git(['status', '--porcelain'], ref.path).trim()).toBe('')
    expect(readFileSync(resolve(ref.path, 'shared.txt'), 'utf-8')).toBe(
      'coder version mars-conflict1\n',
    )
  })

  it('restores uncommitted work after aborting, and names the checkpoint ref', async () => {
    const { syncWorktreeToIntegration, WorktreeRebaseConflictError } = await import(
      '../worktree'
    )
    const ref = await stageRestartedTaskOnStaleBranch({
      taskId: 'mars-conflict2',
      mainCommits: 2,
      conflicting: true,
    })
    writeFileSync(resolve(ref.path, 'app.ts'), 'export const app = 99 // wip\n')

    let caught: unknown
    try {
      await syncWorktreeToIntegration({
        taskId: 'mars-conflict2',
        ref,
        integrationBranch: 'main',
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(WorktreeRebaseConflictError)
    const err = caught as InstanceType<typeof WorktreeRebaseConflictError>
    expect(err.checkpointRef).toBe('refs/mars/checkpoint/setup-mars-conflict2')
    expect(err.message).toContain('no commit and no uncommitted change was discarded')

    // The uncommitted edit is back in the tree AND anchored on the ref, so it
    // is recoverable by name even if the tree is later clobbered.
    expect(readFileSync(resolve(ref.path, 'app.ts'), 'utf-8')).toBe(
      'export const app = 99 // wip\n',
    )
    expect(
      git(['rev-parse', '--verify', err.checkpointRef as string], repoRoot).trim(),
    ).toMatch(/^[0-9a-f]{40}$/)
  })
})

/**
 * Escalating on conflict is correct where the branch's commits ARE the run's
 * premise, but it is catastrophic as the NORMAL path. Measured live: 24 of the
 * ~65 active tasks carry a divergent branch (every one `ahead` 1-2, `behind` up
 * to 335). Three consecutive identical failure signatures trip the
 * signature-storm breaker and pause ALL dispatch — which is exactly what
 * happened. On the setup path for a task that carves its own branch, recreate
 * off the tip instead: the coder redoes a partial turn against current source,
 * and the old tip is parked on a per-task ref so nothing is destroyed.
 */
describe('syncWorktreeToIntegration — recreate-on-conflict (setup, own branch)', () => {
  it('recreates off the integration tip instead of failing', async () => {
    const { syncWorktreeToIntegration } = await import('../worktree')
    const ref = await stageRestartedTaskOnStaleBranch({
      taskId: 'mars-recreate1',
      mainCommits: 2,
      conflicting: true,
    })
    const mainSha = git(['rev-parse', 'main'], repoRoot).trim()

    const outcome = await syncWorktreeToIntegration({
      taskId: 'mars-recreate1',
      ref,
      integrationBranch: 'main',
      onConflict: 'recreate',
    })

    expect(outcome.kind).toBe('recreated')
    // The branch IS the integration tip now, so the coder works on current
    // source and the merge step can fast-forward.
    expect(git(['rev-parse', ref.branch], repoRoot).trim()).toBe(mainSha)
    expect(countAhead('main', ref.branch)).toBe(0)
    expect(readFileSync(resolve(ref.path, 'shared.txt'), 'utf-8')).toBe(
      'main version mars-recreate1 1\n',
    )
    // No rebase left in progress, tree clean.
    expect(git(['status', '--porcelain'], ref.path).trim()).toBe('')
  })

  it('destroys nothing: the old tip and its commits stay reachable on a parked ref', async () => {
    const { syncWorktreeToIntegration, PARKED_REF_PREFIX } = await import('../worktree')
    const ref = await stageRestartedTaskOnStaleBranch({
      taskId: 'mars-recreate2',
      mainCommits: 2,
      conflicting: true,
    })
    const oldTip = git(['rev-parse', ref.branch], repoRoot).trim()

    const outcome = await syncWorktreeToIntegration({
      taskId: 'mars-recreate2',
      ref,
      integrationBranch: 'main',
      onConflict: 'recreate',
    })

    expect(outcome.kind).toBe('recreated')
    if (outcome.kind !== 'recreated') return
    expect(outcome.parkedRef.startsWith(`${PARKED_REF_PREFIX}/mars-recreate2-`)).toBe(true)
    expect(outcome.from).toBe(oldTip)

    // The ref points at the exact pre-reset tip, so every commit that was on
    // the branch is still reachable by name — not dangling, not GC-eligible.
    expect(git(['rev-parse', outcome.parkedRef], repoRoot).trim()).toBe(oldTip)
    expect(outcome.parkedCommits).toHaveLength(1)
    expect(outcome.parkedCommits[0]?.subject).toBe(
      'chore(auto-commit): coder finished but did not commit',
    )
    // And the work is recoverable exactly as the log line advertises.
    expect(git(['log', '--format=%s', `main..${outcome.parkedRef}`], repoRoot).trim()).toBe(
      'chore(auto-commit): coder finished but did not commit',
    )
    expect(
      git(['show', `${outcome.parkedRef}:shared.txt`], repoRoot),
    ).toBe('coder version mars-recreate2\n')
  })

  it('anchors uncommitted work on the checkpoint ref rather than replaying it onto a base it was never written against', async () => {
    const { syncWorktreeToIntegration } = await import('../worktree')
    const ref = await stageRestartedTaskOnStaleBranch({
      taskId: 'mars-recreate3',
      mainCommits: 2,
      conflicting: true,
    })
    writeFileSync(resolve(ref.path, 'app.ts'), 'export const app = 7 // wip\n')

    const outcome = await syncWorktreeToIntegration({
      taskId: 'mars-recreate3',
      ref,
      integrationBranch: 'main',
      onConflict: 'recreate',
    })

    expect(outcome.kind).toBe('recreated')
    if (outcome.kind !== 'recreated') return
    expect(outcome.checkpointRef).toBe('refs/mars/checkpoint/setup-mars-recreate3')

    // The coder gets a clean tree at the integration tip...
    expect(git(['status', '--porcelain'], ref.path).trim()).toBe('')
    expect(readFileSync(resolve(ref.path, 'app.ts'), 'utf-8')).toBe('export const app = 1\n')
    // ...and the wip edit is not lost — it is a named, reachable commit object.
    expect(
      git(['show', `${outcome.checkpointRef}:app.ts`], repoRoot),
    ).toBe('export const app = 7 // wip\n')
    // Still never the shared stash stack.
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/stash'], repoRoot).trim()).toBe('')
  })

  it('still prefers a clean rebase — recreate is the conflict path only', async () => {
    const { syncWorktreeToIntegration } = await import('../worktree')
    const ref = await stageRestartedTaskOnStaleBranch({
      taskId: 'mars-recreate4',
      mainCommits: 3,
      conflicting: false,
    })

    const outcome = await syncWorktreeToIntegration({
      taskId: 'mars-recreate4',
      ref,
      integrationBranch: 'main',
      onConflict: 'recreate',
    })

    // No conflict → the strictly more preserving path wins and the commit is
    // carried forward rather than parked.
    expect(outcome.kind).toBe('rebased')
    expect(countAhead('main', ref.branch)).toBe(1)
    expect(readFileSync(resolve(ref.path, 'feature.ts'), 'utf-8')).toBe(
      'export const feature = 1\n',
    )
  })

  it('is idempotent — a second pass short-circuits instead of re-parking', async () => {
    const { syncWorktreeToIntegration } = await import('../worktree')
    const ref = await stageRestartedTaskOnStaleBranch({
      taskId: 'mars-recreate5',
      mainCommits: 2,
      conflicting: true,
    })

    const first = await syncWorktreeToIntegration({
      taskId: 'mars-recreate5',
      ref,
      integrationBranch: 'main',
      onConflict: 'recreate',
    })
    expect(first.kind).toBe('recreated')

    // setup then code both call this; the second must not park a second ref.
    const second = await syncWorktreeToIntegration({
      taskId: 'mars-recreate5',
      ref,
      integrationBranch: 'main',
      onConflict: 'recreate',
    })
    expect(second).toEqual({ kind: 'already-current' })

    const parked = git(
      ['for-each-ref', '--format=%(refname)', 'refs/mars/parked'],
      repoRoot,
    )
      .split('\n')
      .filter((l) => l.includes('mars-recreate5'))
    expect(parked).toHaveLength(1)
  })

  it('cannot trip the signature-storm breaker: N consecutive stale tasks all resolve without failing', async () => {
    const { syncWorktreeToIntegration } = await import('../worktree')

    // The breaker trips on 3 consecutive identical failure signatures across
    // DIFFERENT tasks (SIGNATURE_STORM_TRIP_THRESHOLD = 3). Drive more than
    // that through the conflict path back to back; every one must succeed, so
    // no signature is ever recorded and dispatch is never paused.
    const outcomes: string[] = []
    for (const taskId of ['mars-storm1', 'mars-storm2', 'mars-storm3', 'mars-storm4']) {
      const ref = await stageRestartedTaskOnStaleBranch({
        taskId,
        mainCommits: 2,
        conflicting: true,
      })
      const outcome = await syncWorktreeToIntegration({
        taskId,
        ref,
        integrationBranch: 'main',
        onConflict: 'recreate',
      })
      outcomes.push(outcome.kind)
      // Each task ends up on current source, ready for its coder.
      expect(countAhead('main', ref.branch)).toBe(0)
    }

    expect(outcomes).toEqual(['recreated', 'recreated', 'recreated', 'recreated'])
    // Every one of them left its history parked and recoverable.
    const parked = git(['for-each-ref', '--format=%(refname)', 'refs/mars/parked'], repoRoot)
    for (const taskId of ['mars-storm1', 'mars-storm2', 'mars-storm3', 'mars-storm4']) {
      expect(parked).toContain(taskId)
    }
  })
})
