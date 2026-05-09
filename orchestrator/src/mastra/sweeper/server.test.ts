import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isBranchMergedIntoMain, isZeroCommitBranch } from './server'

interface ServerModule {
  alertOnStaleWorktree: typeof import('./server').alertOnStaleWorktree
}

interface InboxModule {
  listInboxItems: typeof import('../lib/inbox').listInboxItems
}

const exec = promisify(execFile)

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await exec('git', args, { cwd })
  return stdout.trim()
}

const initRepo = async (cwd: string): Promise<void> => {
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.email', 'test@example.com')
  await git(cwd, 'config', 'user.name', 'test')
  await git(cwd, 'commit', '--allow-empty', '-m', 'init')
}

const commit = async (
  cwd: string,
  file: string,
  body: string,
  message: string,
): Promise<void> => {
  writeFileSync(join(cwd, file), body)
  await git(cwd, 'add', file)
  await git(cwd, 'commit', '-m', message)
}

describe('isBranchMergedIntoMain', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'mars-sweeper-'))
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns true when branch commits have landed in main via fast-forward', async () => {
    await initRepo(repo)
    await git(repo, 'checkout', '-q', '-b', 'task/landed')
    await commit(repo, 'a.txt', 'a', 'feat a')
    await git(repo, 'checkout', '-q', 'main')
    await git(repo, 'merge', '--ff-only', 'task/landed')

    expect(await isBranchMergedIntoMain('task/landed', repo)).toBe(true)
  })

  it('returns false when branch has commits not on main', async () => {
    await initRepo(repo)
    await git(repo, 'checkout', '-q', '-b', 'task/inflight')
    await commit(repo, 'b.txt', 'b', 'feat b')
    expect(await isBranchMergedIntoMain('task/inflight', repo)).toBe(false)
  })

  it('returns false when branch never advanced past its fork point', async () => {
    await initRepo(repo)
    // The recurrence: create a worktree off main, never commit anything,
    // then main moves on. Branch tip = fork point = a commit on main.
    // merge-base --is-ancestor returns true trivially, but the branch
    // never landed work. Without the unique-commit guard, this fed the
    // desync self-heal loop forever for failed/dropped tasks.
    await git(repo, 'checkout', '-q', '-b', 'task/never-advanced')
    await git(repo, 'checkout', '-q', 'main')
    await commit(repo, 'c.txt', 'c', 'main moves on')

    expect(await isBranchMergedIntoMain('task/never-advanced', repo)).toBe(
      false,
    )
  })

  it('returns false when branch is missing', async () => {
    await initRepo(repo)
    expect(await isBranchMergedIntoMain('task/does-not-exist', repo)).toBe(
      false,
    )
  })
})

describe('isZeroCommitBranch', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'mars-sweeper-'))
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns true for a branch with no commits even after main moves forward', async () => {
    await initRepo(repo)
    // Repro of the bug: branch off main, never commit, advance main.
    await git(repo, 'checkout', '-q', '-b', 'task/zero')
    await git(repo, 'checkout', '-q', 'main')
    await commit(repo, 'a.txt', 'a', 'advance main')

    expect(await isZeroCommitBranch('task/zero', repo)).toBe(true)
  })

  it('returns true when branch tip equals main tip (just-created branch)', async () => {
    await initRepo(repo)
    await git(repo, 'checkout', '-q', '-b', 'task/same')
    expect(await isZeroCommitBranch('task/same', repo)).toBe(true)
  })

  it('returns false when the branch has unique commits not yet on main', async () => {
    await initRepo(repo)
    await git(repo, 'checkout', '-q', '-b', 'task/ahead')
    await commit(repo, 'ahead.txt', 'ahead', 'ahead of main')

    expect(await isZeroCommitBranch('task/ahead', repo)).toBe(false)
  })

  it('returns false when the branch does not exist', async () => {
    await initRepo(repo)
    expect(await isZeroCommitBranch('task/does-not-exist', repo)).toBe(false)
  })
})

describe('alertOnStaleWorktree', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-sweeper-alert-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    vi.resetModules()
    process.env.MARS_REPO = repo
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('two consecutive ticks against the same stale worktree dedup into one row with seen_count=2', async () => {
    const server = (await import('./server')) as unknown as ServerModule
    const inbox = (await import('../lib/inbox')) as unknown as InboxModule

    const wt = {
      path: '/tmp/mars-test-worktrees/abc123',
      branch: 'task/abc123',
      taskId: 'abc123',
      mtimeMs: 0,
    }
    const counters = {
      cleaned: 0,
      keptInFlight: 0,
      keptFresh: 0,
      alerted: 0,
      desyncTasks: 0,
    }
    const lines: string[] = []
    const log = (line: string): void => {
      lines.push(line)
    }

    await server.alertOnStaleWorktree(wt, 'failed', 1_000_000, 1.5, log, counters)
    await server.alertOnStaleWorktree(wt, 'failed', 2_000_000, 1.7, log, counters)

    const items = await inbox.listInboxItems('open')
    const stale = items.filter((i) => i.kind === 'stale-worktree')
    expect(stale.length).toBe(1)
    expect(stale[0].seenCount).toBe(2)
    expect(counters.alerted).toBe(2)
  })
})
