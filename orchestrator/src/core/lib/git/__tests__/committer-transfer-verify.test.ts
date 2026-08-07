/**
 * Safety checks for provisionCommitterWorktree state transfer.
 *
 * Two guards run after the per-task checkpoint is restored into the committer
 * worktree, before the committer agent is allowed to run:
 *
 *  1. **Post-transfer integrity check** — the set of files actually staged in
 *     the committer worktree must match the set of files the checkpoint
 *     captured. A mismatch (e.g. a concurrent worktree operation that shifts a
 *     shared stash index — now replaced by per-task refs — would have produced
 *     a different set) aborts with a CommitterTransferMismatchError instead of
 *     allowing the agent to commit the wrong state.
 *
 *  2. **Deletion-only guard** — a committer worktree whose entire staged diff
 *     consists only of file deletions AND whose deletion count exceeds
 *     COMMITTER_DELETION_ONLY_THRESHOLD is almost certainly a corrupt transfer
 *     (the fc56b07d incident: 1,908 deletions of files that were supposed to be
 *     ADDED). These cases abort with CommitterDeletionOnlyError rather than
 *     landing a mass-deletion on the integration branch.
 *
 * All tests use real git processes — the stash-vs-checkpoint distinction only
 * manifests against real git, so mocking the git layer would miss the class of
 * bugs these guards exist to catch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  provisionCommitterWorktree,
  CommitterTransferMismatchError,
  CommitterDeletionOnlyError,
  COMMITTER_DELETION_ONLY_THRESHOLD,
} from '../worktree'
import { checkpointRefFor } from '../checkpoint'
import { __resetContextCacheForTests } from '../../../context'

let repo: string
let prevMarsRepo: string | undefined

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-committer-verify-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@mars.local')
  git(dir, 'config', 'user.name', 'Mars Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(resolve(dir, 'README.md'), 'initial\n')
  writeFileSync(resolve(dir, 'existing.ts'), 'export const x = 1\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

beforeEach(() => {
  repo = setupRepo()
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repo
  __resetContextCacheForTests()
})

afterEach(() => {
  if (prevMarsRepo === undefined) delete process.env.MARS_REPO
  else process.env.MARS_REPO = prevMarsRepo
  __resetContextCacheForTests()
  rmSync(repo, { recursive: true, force: true })
})

describe('post-transfer integrity check', () => {
  it('passes when the restored diff exactly matches the captured checkpoint files', async () => {
    // Mark the integration checkout dirty with two kinds of change:
    // a modification to an existing file and a new untracked file.
    writeFileSync(resolve(repo, 'README.md'), 'modified-content\n')
    writeFileSync(resolve(repo, 'new-feature.ts'), 'export const newThing = 42\n')

    const taskId = 'verify-pass-' + Math.random().toString(36).slice(2, 8)
    const ref = await provisionCommitterWorktree({
      recoveryTaskId: taskId,
      integrationBranch: 'main',
    })

    // The committer worktree should have exactly the same files staged.
    const status = git(ref.path, 'status', '--porcelain')
    expect(status).toContain('README.md')
    expect(status).toContain('new-feature.ts')

    // The integration checkout no longer has tracked-file changes. The .mars/
    // worktrees directory is untracked but git clean deliberately skips
    // directories that contain linked worktrees, so a plain status check is
    // not the right assertion here. What matters is that the tracked dirty
    // files (README.md, new-feature.ts) are gone from main.
    const mainStatus = git(repo, 'status', '--porcelain')
    expect(mainStatus).not.toContain('README.md')
    expect(mainStatus).not.toContain('new-feature.ts')

    git(repo, 'worktree', 'remove', '--force', ref.path)
  }, 60_000)

  it('throws CommitterTransferMismatchError when a captured file cannot be staged in the committer worktree', async () => {
    // Construct the scenario the fc56b07d incident class represents:
    // the integration branch is AHEAD of the checkpoint's parent for one of
    // the captured files, so after cherry-pick that file is missing from the
    // staged diff even though it appears in checkpoint.files.
    //
    // Setup:
    //   commit-A (main): {README.md, doomed.ts, another.ts}
    //   'advanced' branch: commit-A + "delete doomed.ts" → commit-B
    //   dirty main (at commit-A): delete doomed.ts + modify another.ts
    //   checkpoint.files = ['another.ts', 'doomed.ts']
    //
    // After cherry-pick onto the 'advanced' worktree (HEAD=commit-B, no doomed.ts):
    //   - another.ts modification stages ✓
    //   - doomed.ts deletion is a no-op (already absent in HEAD) → NOT staged
    //   - stagedFiles = {'another.ts'} ≠ checkpoint.files → mismatch guard fires

    writeFileSync(resolve(repo, 'doomed.ts'), 'content to delete\n')
    writeFileSync(resolve(repo, 'another.ts'), 'original\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'add doomed.ts and another.ts')

    // Create 'advanced' branch and commit a deletion of doomed.ts there.
    git(repo, 'checkout', '-q', '-b', 'advanced')
    rmSync(resolve(repo, 'doomed.ts'))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'advanced: remove doomed.ts')
    git(repo, 'checkout', '-q', 'main')

    // Dirty main: delete doomed.ts AND modify another.ts so the checkpoint
    // captures both files and restoreCheckpoint sees at least one staged change
    // (another.ts), meaning it doesn't throw CheckpointRestoreError first.
    rmSync(resolve(repo, 'doomed.ts'))
    writeFileSync(resolve(repo, 'another.ts'), 'modified\n')

    const taskId = 'mismatch-' + Math.random().toString(36).slice(2, 8)
    await expect(
      provisionCommitterWorktree({
        recoveryTaskId: taskId,
        integrationBranch: 'advanced',
      }),
    ).rejects.toBeInstanceOf(CommitterTransferMismatchError)

    // Work is preserved: main is still dirty because discardWorkingTreeChanges
    // only runs after the integrity check passes, which it did not.
    const mainStatus = git(repo, 'status', '--porcelain')
    expect(mainStatus).toContain('another.ts')
  }, 60_000)

  it('uses a per-task checkpoint ref and never touches refs/stash', async () => {
    // provisionCommitterWorktree must anchor the captured state under
    // refs/mars/checkpoint/<taskId> (not refs/stash) so that a concurrent
    // task cannot shift a shared stack index and deliver the wrong state —
    // the root cause of the fc56b07d incident.
    writeFileSync(resolve(repo, 'README.md'), 'per-task-ref test\n')

    const taskId = 'ref-test-' + Math.random().toString(36).slice(2, 8)
    const ref = await provisionCommitterWorktree({
      recoveryTaskId: taskId,
      integrationBranch: 'main',
    })

    // The per-task checkpoint ref exists in the common git dir — it is the
    // recovery artifact the operator needs if the restore landed unexpectedly.
    const expectedRef = checkpointRefFor(taskId)
    expect(() => git(repo, 'rev-parse', '--verify', expectedRef)).not.toThrow()

    // The shared stash was never involved.
    expect(git(repo, 'stash', 'list')).toBe('')

    git(repo, 'worktree', 'remove', '--force', ref.path)
  }, 60_000)
})

describe('deletion-only guard', () => {
  it('allows a deletion-only diff that is AT or BELOW the threshold', async () => {
    // Write several files that will be deleted.
    const fileCount = Math.min(COMMITTER_DELETION_ONLY_THRESHOLD, 3)
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(resolve(repo, `to-delete-${i}.ts`), `export const d${i} = ${i}\n`)
    }
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'add files to delete')

    // Now delete them — the dirty state is pure deletions, but below threshold.
    for (let i = 0; i < fileCount; i++) {
      rmSync(resolve(repo, `to-delete-${i}.ts`))
    }

    const taskId = 'del-below-' + Math.random().toString(36).slice(2, 8)
    // Should NOT throw — below the threshold, pure deletions are allowed.
    const ref = await provisionCommitterWorktree({
      recoveryTaskId: taskId,
      integrationBranch: 'main',
    })
    const status = git(ref.path, 'status', '--porcelain')
    expect(status).toContain('to-delete-0.ts')

    git(repo, 'worktree', 'remove', '--force', ref.path)
  }, 60_000)

  it('throws CommitterDeletionOnlyError for a pure-deletion diff above the threshold', async () => {
    // Create enough files to exceed the threshold.
    const fileCount = COMMITTER_DELETION_ONLY_THRESHOLD + 1
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(resolve(repo, `mass-${i}.ts`), `export const m${i} = ${i}\n`)
    }
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'add files for mass-delete test')

    // Delete ALL of them — pure deletion diff, above threshold.
    for (let i = 0; i < fileCount; i++) {
      rmSync(resolve(repo, `mass-${i}.ts`))
    }

    const taskId = 'del-above-' + Math.random().toString(36).slice(2, 8)
    await expect(
      provisionCommitterWorktree({
        recoveryTaskId: taskId,
        integrationBranch: 'main',
      }),
    ).rejects.toBeInstanceOf(CommitterDeletionOnlyError)
  }, 60_000)

  it('does NOT throw when there is a mix of additions and deletions above the threshold', async () => {
    // Create files that will be deleted.
    const fileCount = COMMITTER_DELETION_ONLY_THRESHOLD + 1
    for (let i = 0; i < fileCount; i++) {
      writeFileSync(resolve(repo, `mix-del-${i}.ts`), `export const md${i} = ${i}\n`)
    }
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'add files for mixed test')

    // Delete them all AND add one new file — no longer a pure-deletion diff.
    for (let i = 0; i < fileCount; i++) {
      rmSync(resolve(repo, `mix-del-${i}.ts`))
    }
    writeFileSync(resolve(repo, 'new-addition.ts'), 'export const added = true\n')

    const taskId = 'mix-' + Math.random().toString(36).slice(2, 8)
    // Should NOT throw — mixed changes, not pure deletions.
    const ref = await provisionCommitterWorktree({
      recoveryTaskId: taskId,
      integrationBranch: 'main',
    })
    const status = git(ref.path, 'status', '--porcelain')
    expect(status).toContain('new-addition.ts')

    git(repo, 'worktree', 'remove', '--force', ref.path)
  }, 60_000)
})
