import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isBranchMergedIntoMain, isZeroCommitBranch } from './server'

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
