/**
 * Real-git regression test: two concurrent tasks must not be able to clobber
 * each other's checkpoint.
 *
 * The bug this pins down: `refs/stash` lives in the COMMON git dir, so every
 * linked worktree in the repo shares one stack, and entries are addressed by
 * position (`stash@{0}`, `stash@{1}`) — each push shifts every existing index.
 * With tasks running in parallel, task A's `git stash pop` could therefore
 * restore the entry task B had just pushed, silently moving B's uncommitted
 * work into A's tree (this happened for real on this repo: a pop returned a
 * `.gitignore` change belonging to an unrelated task branch).
 *
 * The replacement (`core/lib/git/checkpoint.ts`) writes each checkpoint to a
 * per-task ref and restores it by naming the exact commit object, so:
 *
 *  - interleaving two captures cannot swap what each task gets back,
 *  - nothing the orchestrator does touches `refs/stash` at all.
 *
 * Both properties are asserted below against a real git repo with real
 * worktrees — the LIFO stack semantics that caused the bug only show up
 * against real git, so this test deliberately does not mock anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  captureCheckpoint,
  checkpointRefFor,
  restoreCheckpoint,
  discardWorkingTreeChanges,
  CheckpointRestoreError,
} from '../checkpoint'
import { __resetContextCacheForTests } from '../../../context'

let repo: string
let prevMarsRepo: string | undefined

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-checkpoint-iso-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@mars.local')
  git(dir, 'config', 'user.name', 'Mars Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(resolve(dir, 'README.md'), 'hi\n')
  writeFileSync(resolve(dir, 'doomed.txt'), 'delete me\n')
  writeFileSync(resolve(dir, '.gitignore'), 'ignored/\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/** Add a worktree on its own branch, mirroring how the orchestrator provisions one. */
const addWorktree = (name: string): string => {
  const path = resolve(repo, '.mars', 'worktrees', name)
  git(repo, 'worktree', 'add', '-q', '-b', `task/${name}`, path, 'main')
  return path
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

describe('checkpoint isolation between concurrent tasks', () => {
  it('interleaved captures restore each task its OWN work, never the other task\'s', async () => {
    // Two tasks, each with its own worktree and its own uncommitted work.
    const srcA = addWorktree('task-a')
    const srcB = addWorktree('task-b')
    writeFileSync(resolve(srcA, 'README.md'), 'WORK OF TASK A\n')
    writeFileSync(resolve(srcA, 'only-a.txt'), 'a-untracked\n')
    writeFileSync(resolve(srcB, 'README.md'), 'WORK OF TASK B\n')
    writeFileSync(resolve(srcB, 'only-b.txt'), 'b-untracked\n')

    // Interleave the captures the way parallel dispatch does. On the old
    // shared stack this ordering is precisely what made A's later pop return
    // B's entry: B's push shifted A's entry from stash@{0} to stash@{1}.
    const cpA = await captureCheckpoint({ cwd: srcA, key: 'task-a', message: 'checkpoint A' })
    const cpB = await captureCheckpoint({ cwd: srcB, key: 'task-b', message: 'checkpoint B' })
    expect(cpA).not.toBeNull()
    expect(cpB).not.toBeNull()
    if (cpA === null || cpB === null) throw new Error('unreachable')

    // Distinct, per-task refs — not two positions on one stack.
    expect(cpA.ref).toBe(checkpointRefFor('task-a'))
    expect(cpB.ref).toBe(checkpointRefFor('task-b'))
    expect(cpA.ref).not.toBe(cpB.ref)
    expect(cpA.sha).not.toBe(cpB.sha)

    // Both source trees are cleared, exactly as `git stash push` used to do.
    await discardWorkingTreeChanges({ cwd: srcA })
    await discardWorkingTreeChanges({ cwd: srcB })
    expect(git(srcA, 'status', '--porcelain')).toBe('')
    expect(git(srcB, 'status', '--porcelain')).toBe('')

    // Restore in the order that broke the stack: A first (its entry is the
    // OLDER one), then B.
    const dstA = addWorktree('dest-a')
    const dstB = addWorktree('dest-b')
    await restoreCheckpoint({ cwd: dstA, checkpoint: cpA })
    await restoreCheckpoint({ cwd: dstB, checkpoint: cpB })

    // The load-bearing assertion: neither task received the other's work.
    expect(readFileSync(resolve(dstA, 'README.md'), 'utf8')).toBe('WORK OF TASK A\n')
    expect(readFileSync(resolve(dstA, 'only-a.txt'), 'utf8')).toBe('a-untracked\n')
    expect(existsSync(resolve(dstA, 'only-b.txt'))).toBe(false)

    expect(readFileSync(resolve(dstB, 'README.md'), 'utf8')).toBe('WORK OF TASK B\n')
    expect(readFileSync(resolve(dstB, 'only-b.txt'), 'utf8')).toBe('b-untracked\n')
    expect(existsSync(resolve(dstB, 'only-a.txt'))).toBe(false)

    // A restore consumes nothing: each task's checkpoint is still addressable
    // by name afterwards, so one task can never "use up" another's entry.
    expect(git(repo, 'rev-parse', cpA.ref)).toBe(cpA.sha)
    expect(git(repo, 'rev-parse', cpB.ref)).toBe(cpB.sha)

    // And the shared, index-addressed stack was never involved.
    expect(git(repo, 'stash', 'list')).toBe('')
  }, 60_000)

  it('never writes to the shared refs/stash and leaves a pre-existing stash entry untouched', async () => {
    // An operator (or an agent) left an entry on the shared stack. Nothing the
    // orchestrator does may push onto it, pop from it, or reorder it.
    writeFileSync(resolve(repo, 'README.md'), 'SOMEONE ELSES WORK\n')
    git(repo, 'stash', 'push', '-m', 'unrelated entry')
    const stashShaBefore = git(repo, 'rev-parse', 'refs/stash')

    const src = addWorktree('task-c')
    writeFileSync(resolve(src, 'README.md'), 'TASK C WORK\n')
    const cp = await captureCheckpoint({ cwd: src, key: 'task-c', message: 'checkpoint C' })
    expect(cp).not.toBeNull()
    if (cp === null) throw new Error('unreachable')
    await discardWorkingTreeChanges({ cwd: src })

    const dst = addWorktree('dest-c')
    await restoreCheckpoint({ cwd: dst, checkpoint: cp })

    // The restore produced task C's content, NOT the stashed entry's.
    expect(readFileSync(resolve(dst, 'README.md'), 'utf8')).toBe('TASK C WORK\n')
    // The unrelated entry is still exactly where its owner left it.
    expect(git(repo, 'stash', 'list')).toContain('unrelated entry')
    expect(git(repo, 'rev-parse', 'refs/stash')).toBe(stashShaBefore)
  }, 60_000)

  it('captures tracked edits, deletions and untracked files but never ignored files', async () => {
    const src = addWorktree('task-d')
    writeFileSync(resolve(src, 'README.md'), 'edited\n')
    writeFileSync(resolve(src, 'new.txt'), 'new\n')
    mkdirSync(resolve(src, 'ignored'), { recursive: true })
    writeFileSync(resolve(src, 'ignored', 'junk.txt'), 'junk\n')
    rmSync(resolve(src, 'doomed.txt'))

    const cp = await captureCheckpoint({ cwd: src, key: 'task-d', message: 'checkpoint D' })
    expect(cp).not.toBeNull()
    if (cp === null) throw new Error('unreachable')
    expect(cp.files.sort()).toEqual(['README.md', 'doomed.txt', 'new.txt'])
    expect(cp.files).not.toContain('ignored/junk.txt')

    // Discarding leaves ignored files on disk — they are outside what a
    // checkpoint can hold, so blowing them away would be unrecoverable.
    await discardWorkingTreeChanges({ cwd: src })
    expect(git(src, 'status', '--porcelain')).toBe('')
    expect(existsSync(resolve(src, 'ignored', 'junk.txt'))).toBe(true)
  }, 60_000)

  it('returns null when there is nothing capturable', async () => {
    const src = addWorktree('task-e')
    mkdirSync(resolve(src, 'ignored'), { recursive: true })
    writeFileSync(resolve(src, 'ignored', 'junk.txt'), 'junk\n')
    expect(await captureCheckpoint({ cwd: src, key: 'task-e', message: 'nothing' })).toBeNull()
    expect(git(repo, 'stash', 'list')).toBe('')
  }, 60_000)

  it('fails loudly instead of silently leaving a conflicted tree', async () => {
    const src = addWorktree('task-f')
    writeFileSync(resolve(src, 'README.md'), 'checkpointed content\n')
    const cp = await captureCheckpoint({ cwd: src, key: 'task-f', message: 'checkpoint F' })
    if (cp === null) throw new Error('unreachable')
    await discardWorkingTreeChanges({ cwd: src })

    // The destination has a COMMITTED, conflicting change to the same file, so
    // the three-way apply cannot succeed.
    const dst = addWorktree('dest-f')
    writeFileSync(resolve(dst, 'README.md'), 'divergent content\n')
    git(dst, 'commit', '-q', '-am', 'divergent')

    await expect(restoreCheckpoint({ cwd: dst, checkpoint: cp })).rejects.toBeInstanceOf(
      CheckpointRestoreError,
    )
    // The checkpoint survives the failed restore — the work is recoverable.
    expect(git(repo, 'rev-parse', cp.ref)).toBe(cp.sha)
  }, 60_000)
})
