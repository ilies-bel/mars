/**
 * Real-git regression test for `anchorBranchTip` (mars-7f2de34d).
 *
 * The incident: a live task parked at a manual step, work was committed in its
 * worktree, the daemon restarted, and `mars step done` took the sentinel
 * re-queue fallback. The task's worktree AND branch were both gone afterwards
 * — the operator's commit survived only as a dangling object, one `gc` away
 * from being unrecoverable, and had to be rescued by hand.
 *
 * `anchorBranchTip` is the safety net: before the degraded re-queue, the
 * branch tip is named by a per-task ref. A named ref is a GC root, so the
 * commit stays reachable no matter what happens to the branch downstream.
 *
 * These assertions only mean something against real git — reachability,
 * GC roots, and `branch -D` semantics are exactly what a mock would paper
 * over — so nothing here is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { anchorBranchTip } from '../checkpoint'
import { __resetContextCacheForTests } from '../../../context'

let repo: string
let prevMarsRepo: string | undefined

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
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/** Add a worktree on its own branch, mirroring how the orchestrator provisions one. */
const addWorktree = (name: string): string => {
  const path = resolve(repo, '.mars', 'worktrees', name)
  git(repo, 'worktree', 'add', '-q', '-b', `task/${name}`, path, 'main')
  return path
}

/** Commit a file in `path`, the way an operator does during a live manual step. */
const commitWork = (path: string, file: string, body: string, message: string): string => {
  writeFileSync(resolve(path, file), body)
  git(path, 'add', '-A')
  git(path, 'commit', '-q', '-m', message)
  return git(path, 'rev-parse', 'HEAD')
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

describe('anchorBranchTip', () => {
  it("keeps an operator's commit reachable after the branch and worktree are destroyed", async () => {
    // Reproduce the incident's starting state: a live task's worktree holding
    // a real, unmerged, committed piece of operator work.
    const wt = addWorktree('mars-7f2de34d')
    const workSha = commitWork(wt, 'operator-work.txt', 'hard-won work\n', 'the work')

    const anchored = await anchorBranchTip({
      worktreePath: wt,
      key: 'step-done-fallback-mars-7f2de34d',
    })
    expect(anchored).not.toBeNull()
    if (anchored === null) throw new Error('unreachable')
    expect(anchored.sha).toBe(workSha)
    expect(git(repo, 'rev-parse', anchored.ref)).toBe(workSha)

    // Now do exactly what the incident did: destroy the worktree and the
    // branch that held the commit.
    git(repo, 'worktree', 'remove', '--force', wt)
    git(repo, 'branch', '-D', 'task/mars-7f2de34d')
    expect(() => git(repo, 'rev-parse', '--verify', 'task/mars-7f2de34d')).toThrow()

    // The load-bearing assertion: without the anchor this commit would be a
    // dangling object. With it, it is still named, still reachable, and still
    // recoverable — and `gc --prune=now` cannot touch it, because a ref is a
    // GC root.
    git(repo, 'gc', '--prune=now', '--quiet')
    expect(git(repo, 'rev-parse', anchored.ref)).toBe(workSha)
    expect(git(repo, 'cat-file', '-t', workSha)).toBe('commit')

    // And the recovery command the CLI prints actually works.
    const rescue = addWorktree('rescue')
    git(rescue, 'cherry-pick', '-n', anchored.ref)
    expect(readFileSync(resolve(rescue, 'operator-work.txt'), 'utf8')).toBe('hard-won work\n')
  })

  it('leaves the branch, HEAD and uncommitted changes untouched', async () => {
    const wt = addWorktree('untouched')
    const headSha = commitWork(wt, 'committed.txt', 'committed\n', 'committed work')
    // Dirt of both kinds: a modified tracked file and an untracked one.
    writeFileSync(resolve(wt, 'committed.txt'), 'locally modified\n')
    writeFileSync(resolve(wt, 'untracked.txt'), 'untracked\n')
    const statusBefore = git(wt, 'status', '--porcelain')

    await anchorBranchTip({ worktreePath: wt, key: 'untouched' })

    // Anchoring is a single `update-ref`: it names an existing commit and must
    // not move the branch, detach HEAD, or disturb the working tree the
    // operator is still standing in.
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(headSha)
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/untouched')
    expect(git(wt, 'status', '--porcelain')).toBe(statusBefore)
    expect(readFileSync(resolve(wt, 'committed.txt'), 'utf8')).toBe('locally modified\n')
    expect(readFileSync(resolve(wt, 'untracked.txt'), 'utf8')).toBe('untracked\n')
  })

  it('anchors each tip under its own ref, so a second call cannot clobber the first', async () => {
    // Two degraded `step done` calls in a row on the same task: the second
    // must not overwrite the ref that is holding the first tip.
    const wt = addWorktree('twice')
    const firstSha = commitWork(wt, 'one.txt', 'one\n', 'first')
    const first = await anchorBranchTip({ worktreePath: wt, key: 'step-done-fallback-twice' })
    const secondSha = commitWork(wt, 'two.txt', 'two\n', 'second')
    const second = await anchorBranchTip({ worktreePath: wt, key: 'step-done-fallback-twice' })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    if (first === null || second === null) throw new Error('unreachable')
    expect(first.ref).not.toBe(second.ref)
    expect(git(repo, 'rev-parse', first.ref)).toBe(firstSha)
    expect(git(repo, 'rev-parse', second.ref)).toBe(secondSha)
  })

  it('returns null instead of throwing when there is no commit to anchor', async () => {
    // An unborn branch has no HEAD to resolve. The anchor is a best-effort
    // safety net on the re-queue path, so "nothing to anchor" must degrade to
    // null rather than take down `mars step done`.
    const empty = mkdtempSync(resolve(tmpdir(), 'mars-anchor-unborn-'))
    git(empty, 'init', '-q', '-b', 'main')
    try {
      await expect(anchorBranchTip({ worktreePath: empty, key: 'unborn' })).resolves.toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
