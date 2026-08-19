/**
 * Real-git regression test for `anchorBranchTip` (mars-a98bec46).
 *
 * Context: `handleStepDone`'s sentinel-fallback path (Path 2 — taken when the
 * daemon restarted between a manual step parking and `mars step done` being
 * called) re-queues the task for the engine to re-enter on the next dispatch.
 * That re-entry is expected to resume past `setup` and the parked step using
 * the persisted workflow checkpoint, never touching the worktree — but
 * mars-7f2de34d showed a re-queue can end up back at `setup`, which recreated
 * the worktree and discarded the branch's committed work. `anchorBranchTip` is
 * the safety net: before the re-queue, name the branch's CURRENT tip on a
 * per-task ref, so the commit is recoverable by name even if something
 * downstream resets the branch.
 *
 * These tests exercise `anchorBranchTip` against a real git repo with a real
 * linked worktree — no mocking, since the whole point is that the ref survives
 * whatever the caller does to the branch afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { anchorBranchTip, checkpointRefFor } from '../checkpoint'

let repo: string

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-anchor-tip-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@mars.local')
  git(dir, 'config', 'user.name', 'Mars Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(resolve(dir, 'README.md'), 'hi\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** Add a linked worktree on its own branch, mirroring how setup provisions one. */
const addWorktree = (name: string): string => {
  const path = resolve(repo, '.mars-worktrees', name)
  git(repo, 'worktree', 'add', '-q', '-b', `task/${name}`, path, 'main')
  return path
}

beforeEach(() => {
  repo = setupRepo()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('anchorBranchTip', () => {
  it('anchors the branch tip on a per-task ref that survives a branch reset', async () => {
    const wt = addWorktree('task-a')
    writeFileSync(resolve(wt, 'work.txt'), 'operator committed this\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-q', '-m', 'operator work')
    const tipBeforeReset = git(wt, 'rev-parse', 'HEAD')

    const anchored = await anchorBranchTip({ worktreePath: wt, key: 'step-done-fallback-task-a' })
    expect(anchored).not.toBeNull()
    if (anchored === null) throw new Error('unreachable')
    expect(anchored.sha).toBe(tipBeforeReset)
    expect(anchored.ref).toBe(checkpointRefFor(`step-done-fallback-task-a-${tipBeforeReset.slice(0, 9)}`))

    // Simulate the destructive scenario the anchor guards against: something
    // downstream resets the branch back to main, discarding the operator's
    // commit from the branch tip.
    git(wt, 'reset', '--hard', 'main')
    expect(git(wt, 'rev-parse', 'HEAD')).not.toBe(tipBeforeReset)

    // The commit is still reachable by name via the anchor ref — nothing was
    // lost, even though the branch itself moved.
    expect(git(repo, 'rev-parse', anchored.ref)).toBe(tipBeforeReset)
    expect(git(repo, 'cat-file', '-t', anchored.ref)).toBe('commit')
  })

  it('is idempotent: anchoring the same tip twice writes the same ref to the same sha', async () => {
    const wt = addWorktree('task-b')
    writeFileSync(resolve(wt, 'work.txt'), 'work\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-q', '-m', 'work')

    const first = await anchorBranchTip({ worktreePath: wt, key: 'step-done-fallback-task-b' })
    const second = await anchorBranchTip({ worktreePath: wt, key: 'step-done-fallback-task-b' })
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    if (first === null || second === null) throw new Error('unreachable')
    expect(second.ref).toBe(first.ref)
    expect(second.sha).toBe(first.sha)
  })

  it('anchors a fresh ref per distinct tip, so two degraded step-done calls never collide', async () => {
    const wt = addWorktree('task-c')
    writeFileSync(resolve(wt, 'first.txt'), 'first\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-q', '-m', 'first commit')
    const first = await anchorBranchTip({ worktreePath: wt, key: 'step-done-fallback-task-c' })

    writeFileSync(resolve(wt, 'second.txt'), 'second\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-q', '-m', 'second commit')
    const second = await anchorBranchTip({ worktreePath: wt, key: 'step-done-fallback-task-c' })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    if (first === null || second === null) throw new Error('unreachable')
    expect(second.ref).not.toBe(first.ref)
    // Both tips remain independently recoverable.
    expect(git(repo, 'rev-parse', first.ref)).toBe(first.sha)
    expect(git(repo, 'rev-parse', second.ref)).toBe(second.sha)
  })

  it('never touches refs/stash', async () => {
    const wt = addWorktree('task-d')
    writeFileSync(resolve(wt, 'work.txt'), 'work\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-q', '-m', 'work')

    await anchorBranchTip({ worktreePath: wt, key: 'step-done-fallback-task-d' })

    expect(git(repo, 'stash', 'list')).toBe('')
  })

  it('returns null when HEAD cannot be resolved (unborn branch)', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mars-anchor-tip-unborn-'))
    try {
      git(dir, 'init', '-q', '-b', 'unborn')
      const anchored = await anchorBranchTip({ worktreePath: dir, key: 'step-done-fallback-unborn' })
      expect(anchored).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
