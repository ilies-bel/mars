/**
 * Real-git regression test for `startPeriodicCheckpoint`: the safety net
 * that snapshots a coder's worktree on a fixed cadence so a hard-killed
 * subprocess (watchdog timeout, context exhaustion, OOM) never loses
 * everything it produced.
 *
 * The scenario this pins down: a coder subprocess dies mid-run without
 * ever reaching an exit-time recovery hook. Before this, the only work
 * that survived was whatever the coder itself had already committed —
 * observed for real on 2026-08-20, three `code:context-exhausted`
 * failures in a row each left 100+ uncommitted lines with zero commits
 * ahead. `startPeriodicCheckpoint` makes that recovery automatic: work
 * lands on `refs/mars/checkpoint/<key>` as it is produced, restorable with
 * no operator intervention.
 *
 * Runs against a real git repo with a real worktree — no mocking — the
 * same harness as `checkpoint-isolation.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  captureCheckpoint,
  checkpointRefFor,
  restoreCheckpoint,
  startPeriodicCheckpoint,
} from '../checkpoint'
import { __resetContextCacheForTests } from '../../../context'

let repo: string
let prevMarsRepo: string | undefined

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-periodic-checkpoint-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@mars.local')
  git(dir, 'config', 'user.name', 'Mars Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(resolve(dir, 'README.md'), 'hi\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** Add a worktree on its own branch, mirroring how the orchestrator provisions one. */
const addWorktree = (name: string): string => {
  const path = resolve(repo, 'worktrees', name)
  git(repo, 'worktree', 'add', '-q', '-b', `task/${name}`, path, 'main')
  return path
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

describe('startPeriodicCheckpoint', () => {
  it('produces a durable, restorable checkpoint from uncommitted work without the coder ever committing', async () => {
    const worktree = addWorktree('task-periodic')
    const handle = startPeriodicCheckpoint({
      cwd: worktree,
      key: 'task-periodic-code-periodic',
      messagePrefix: 'mars: periodic code-phase checkpoint (task task-periodic)',
      intervalMs: 30,
    })

    try {
      // Simulate the coder producing work mid-run — never committed, exactly
      // the state a hard kill would otherwise lose entirely.
      writeFileSync(resolve(worktree, 'progress.txt'), 'work in progress\n')

      // Let at least one tick elapse.
      await sleep(200)
    } finally {
      await handle.stop()
    }

    // No commits landed on the branch itself — the coder never committed.
    expect(git(worktree, 'rev-list', '--count', 'HEAD')).toBe('1')

    // But the work is durable: a checkpoint ref exists and is restorable
    // into a fresh worktree with no operator intervention beyond calling
    // the documented recovery primitive.
    const ref = checkpointRefFor('task-periodic-code-periodic')
    const sha = git(repo, 'rev-parse', ref)
    expect(sha).not.toBe('')

    const dest = addWorktree('recovered')
    await restoreCheckpoint({
      cwd: dest,
      checkpoint: { ref, sha, files: ['progress.txt'] },
    })
    expect(readFileSync(resolve(dest, 'progress.txt'), 'utf8')).toBe('work in progress\n')
  }, 60_000)

  it('is a no-op once the coder commits its own work — no duplicate or conflicting checkpoint', async () => {
    const worktree = addWorktree('task-normal')
    const handle = startPeriodicCheckpoint({
      cwd: worktree,
      key: 'task-normal-code-periodic',
      messagePrefix: 'mars: periodic code-phase checkpoint (task task-normal)',
      intervalMs: 30,
    })

    try {
      // The coder behaves well: writes, then commits, well before any tick
      // could plausibly race it in a slow CI environment.
      writeFileSync(resolve(worktree, 'done.txt'), 'finished\n')
      git(worktree, 'add', '-A')
      git(worktree, 'commit', '-q', '-m', 'feat: finish the task')

      // Give the timer ample opportunity to fire against the now-clean tree.
      await sleep(200)
    } finally {
      await handle.stop()
    }

    // The branch carries exactly the coder's own commit — no checkpoint
    // commit was appended on top of a clean tree.
    expect(git(worktree, 'rev-list', '--count', 'HEAD')).toBe('2')
    expect(git(worktree, 'log', '-1', '--format=%s')).toBe('feat: finish the task')

    // captureCheckpoint against the now-clean tree confirms there is nothing
    // left to capture — the periodic timer's no-op is the same guarantee a
    // manual capture would get.
    const result = await captureCheckpoint({
      cwd: worktree,
      key: 'task-normal-code-periodic-manual-probe',
      message: 'probe',
    })
    expect(result).toBeNull()
  }, 60_000)

  it('stops cleanly: no further captures happen once stop() resolves', async () => {
    const worktree = addWorktree('task-stop')
    const handle = startPeriodicCheckpoint({
      cwd: worktree,
      key: 'task-stop-code-periodic',
      messagePrefix: 'mars: periodic code-phase checkpoint (task task-stop)',
      intervalMs: 30,
    })

    writeFileSync(resolve(worktree, 'a.txt'), 'a\n')
    await sleep(100)
    await handle.stop()

    const ref = checkpointRefFor('task-stop-code-periodic')
    const shaAfterStop = git(repo, 'rev-parse', ref)

    // Mutate the tree again after stop() and wait past another would-be
    // interval — a stopped handle must never fire again.
    writeFileSync(resolve(worktree, 'b.txt'), 'b\n')
    await sleep(150)

    expect(git(repo, 'rev-parse', ref)).toBe(shaAfterStop)
  }, 60_000)
})
