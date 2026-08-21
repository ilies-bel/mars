/**
 * Real-git regression test: `mergeBranch`'s post-merge dirty-tree check must
 * reset stale-tree debris silently instead of checkpointing it.
 *
 * Reproduces the "phantom-dirt cascade" incident shape (2026-08-20/21): the
 * primary integration checkout is one merge behind its own HEAD — a PRIOR
 * merge advanced `refs/heads/main` via a working-tree-free `update-ref` but
 * the checkout's disk/index never caught up (Step 3 declined to resync
 * because, at the time, it could not tell "stale re-sync debris" apart from
 * "operator edits"). When the NEXT merge lands, `post-merge-assert` finds the
 * checkout dirty in a shape that is EXACTLY the inverse of the range between
 * the last recorded sync and the new HEAD — the "inverse-diff phantom".
 *
 * Before this slice, that dirt was indistinguishable from genuine operator
 * work and got checkpointed (`refs/mars/checkpoint/...`) even though nothing
 * was actually at risk. This test asserts the merge now calls
 * `attributeIntegrationDirt` first, classifies the dirt as `stale-tree-debris`,
 * and resets the checkout to the new HEAD directly: no checkpoint ref, no
 * failure, `merged: true`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { mergeBranch } from '../merge'
import { writeLastSyncedSha } from '../last-synced-sha'
import { __resetContextCacheForTests } from '../../../context'

let repoDir: string
let phantomWtDir: string
let taskWtDir: string
let prevMarsRepo: string | undefined

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeAll(() => {
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-stale-tree-reset-'))
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()

  git(repoDir, 'init', '-b', 'main')
  git(repoDir, 'config', 'user.email', 'test@mars.local')
  git(repoDir, 'config', 'user.name', 'Mars Test')
  git(repoDir, 'config', 'commit.gpgsign', 'false')

  // Mirror the real repo's root `.gitignore`: `/.mars` is always ignored
  // there (it holds the daemon's per-repo state, including the merge lock
  // and the last-synced-sha file this test writes below). Without this, the
  // `.mars/` files created by `writeLastSyncedSha` and `mergeBranch`'s own
  // lock acquisition would show up as untracked (`??`) in this scratch repo
  // — which `attributeIntegrationDirt` always treats as operator-dirt,
  // masking the exact scenario this test means to reproduce.
  writeFileSync(resolve(repoDir, '.gitignore'), '/.mars\n')
  git(repoDir, 'add', '.gitignore')
  git(repoDir, 'commit', '-m', 'gitignore')

  // c0: baseline commit on main. The primary checkout's disk + index will
  // stay pinned here for the rest of setup — that is the "stale" part.
  writeFileSync(resolve(repoDir, 'keep.txt'), 'unchanged\n')
  git(repoDir, 'add', 'keep.txt')
  git(repoDir, 'commit', '-m', 'c0')
  const c0Sha = git(repoDir, 'rev-parse', 'HEAD')

  // Record c0 as the last-known-good sync point — as if an earlier merge's
  // Step 3 had successfully reset the checkout to c0 at some point in the past.
  writeLastSyncedSha(c0Sha, repoDir)

  // c1: simulates an EARLIER merge that fast-forwarded `main` from c0 to c1
  // via a working-tree-free `update-ref`, without ever resyncing the primary
  // checkout's disk/index. Build the commit in a separate linked worktree
  // (so the primary checkout's own tree is never touched) and land it on
  // `main` with a raw ref update, exactly like `mergeBranch`'s fast-forward.
  phantomWtDir = resolve(repoDir, '..', `${repoDir.split('/').pop()}-phantom-wt`)
  git(repoDir, 'worktree', 'add', '--detach', phantomWtDir, c0Sha)
  git(phantomWtDir, 'config', 'user.email', 'test@mars.local')
  git(phantomWtDir, 'config', 'user.name', 'Mars Test')
  writeFileSync(resolve(phantomWtDir, 'already-added.txt'), 'from an earlier merge\n')
  git(phantomWtDir, 'add', 'already-added.txt')
  git(phantomWtDir, 'commit', '-m', 'c1 (earlier merge payload)')
  const c1Sha = git(phantomWtDir, 'rev-parse', 'HEAD')
  git(repoDir, 'worktree', 'remove', '--force', phantomWtDir)
  // Raw ref update: `main` now points at c1, but repoDir's disk/index are
  // still exactly c0 — the phantom "one merge behind" checkout.
  git(repoDir, 'update-ref', 'refs/heads/main', c1Sha)

  // Now set up the task branch this test's `mergeBranch` call will actually
  // merge: it branches off the TRUE current tip of main (c1) and adds its own
  // file, in its own worktree — exactly how the orchestrator arranges things.
  taskWtDir = resolve(repoDir, '..', `${repoDir.split('/').pop()}-task-wt`)
  git(repoDir, 'branch', 'task/feat', c1Sha)
  git(repoDir, 'worktree', 'add', taskWtDir, 'task/feat')
  git(taskWtDir, 'config', 'user.email', 'test@mars.local')
  git(taskWtDir, 'config', 'user.name', 'Mars Test')
  writeFileSync(resolve(taskWtDir, 'added-by-merge.txt'), 'this task\n')
  git(taskWtDir, 'add', 'added-by-merge.txt')
  git(taskWtDir, 'commit', '-m', 'c2 (this task)')
})

afterAll(() => {
  if (prevMarsRepo === undefined) delete process.env.MARS_REPO
  else process.env.MARS_REPO = prevMarsRepo
  __resetContextCacheForTests()
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(taskWtDir, { recursive: true, force: true })
})

describe('mergeBranch — stale-tree debris on the integration checkout', () => {
  it('resets the checkout silently instead of checkpointing it', async () => {
    // Sanity: the primary checkout is dirty relative to `main` before the
    // merge even runs (it is one merge behind its own branch ref) — this is
    // the exact "inverse-diff phantom" shape.
    expect(git(repoDir, 'status', '--porcelain', '--untracked-files=no')).not.toBe('')

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: taskWtDir,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
    })

    expect(result.aborted).toBe(false)
    expect(result.merged).toBe(true)
    expect(git(repoDir, 'rev-parse', 'main')).toBe(git(repoDir, 'rev-parse', 'task/feat'))

    // The checkout must end up clean — a plain reset, not a checkpoint.
    expect(git(repoDir, 'status', '--porcelain', '--untracked-files=no')).toBe('')

    // Both the earlier merge's payload and this task's file must now be
    // materialised on disk.
    expect(readFileSync(resolve(repoDir, 'already-added.txt'), 'utf8')).toBe(
      'from an earlier merge\n',
    )
    expect(readFileSync(resolve(repoDir, 'added-by-merge.txt'), 'utf8')).toBe('this task\n')

    // No checkpoint ref was created for stale-tree debris.
    const refs = git(repoDir, 'for-each-ref', '--format=%(refname)', 'refs/mars/checkpoint')
      .split('\n')
      .filter((l) => l.length > 0)
    expect(refs).toHaveLength(0)

    // The shared stash stack was never touched either.
    expect(git(repoDir, 'stash', 'list')).toBe('')
  }, 60_000)
})
