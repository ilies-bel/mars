import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isZeroCommitBranch } from './server'

const git = (repo: string, args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-sweeper-test-'))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}

describe('isZeroCommitBranch', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns true for a branch with no commits even after main moves forward', async () => {
    // Repro of the bug: branch off main, never commit, advance main.
    git(repo, ['checkout', '-q', '-b', 'task/zero'])
    git(repo, ['checkout', '-q', 'main'])
    writeFileSync(resolve(repo, 'a.txt'), 'a\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'advance main'])

    expect(await isZeroCommitBranch('task/zero', repo)).toBe(true)
  })

  it('returns true when branch tip equals main tip (just-created branch)', async () => {
    git(repo, ['checkout', '-q', '-b', 'task/same'])
    expect(await isZeroCommitBranch('task/same', repo)).toBe(true)
  })

  it('returns false when the branch has unique commits not yet on main', async () => {
    git(repo, ['checkout', '-q', '-b', 'task/ahead'])
    writeFileSync(resolve(repo, 'ahead.txt'), 'ahead\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'ahead of main'])

    expect(await isZeroCommitBranch('task/ahead', repo)).toBe(false)
  })

  it('returns false when the branch does not exist', async () => {
    expect(await isZeroCommitBranch('task/does-not-exist', repo)).toBe(false)
  })
})
