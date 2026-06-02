/**
 * Integration tests for applyCommitsCherryPick against a real git repo.
 *
 * These tests verify that the real git boundary behaves correctly — stub-only
 * tests cannot catch git-level failures such as wrong commit ordering or
 * cherry-pick abort state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { applyCommitsCherryPick } from '../sweep'

/** Create a temp git repo on 'main' with an initial commit. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-sweep-cherry-pick-'))
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
  })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return repo
}

/** Return the short SHAs of commits on current branch, newest-first. */
const logShas = (repo: string): string[] =>
  execSync('git log --format=%h', { cwd: repo })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)

/** Return commit subjects, newest-first. */
const logSubjects = (repo: string): string[] =>
  execSync('git log --format=%s', { cwd: repo })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)

describe('applyCommitsCherryPick — real git', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('applies commits oldest-first onto the integration branch', async () => {
    // Create orphan branch with two commits
    execFileSync('git', ['checkout', '-b', 'task/mars-orphan'], { cwd: repo })
    writeFileSync(resolve(repo, 'a.txt'), 'alpha\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'feat: alpha'], { cwd: repo })

    writeFileSync(resolve(repo, 'b.txt'), 'beta\n')
    execFileSync('git', ['add', 'b.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'feat: beta'], { cwd: repo })

    // Get the commits in git log order (newest-first: beta, alpha)
    const [betaSha, alphaSha] = logShas(repo)

    // Checkout main before running the verb
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    const mainCommitsBefore = logShas(repo).length

    // Commits oldest-first: alpha, beta
    const result = await applyCommitsCherryPick(
      [
        { shortSha: alphaSha, subject: 'feat: alpha' },
        { shortSha: betaSha, subject: 'feat: beta' },
      ],
      'main',
      repo,
    )

    expect(result).toEqual({ ok: true })

    // Both commits should now be on main (newest-first: beta, alpha, init)
    const subjects = logSubjects(repo)
    expect(subjects[0]).toBe('feat: beta')
    expect(subjects[1]).toBe('feat: alpha')
    expect(logShas(repo).length).toBe(mainCommitsBefore + 2)
  })

  it('returns the conflicting commit and leaves the working tree clean on conflict', async () => {
    // Create a file on main that will conflict
    writeFileSync(resolve(repo, 'shared.txt'), 'line A\n')
    execFileSync('git', ['add', 'shared.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'add shared'], { cwd: repo })

    // Create orphan branch that modifies shared.txt
    execFileSync('git', ['checkout', '-b', 'task/mars-orphan'], { cwd: repo })
    writeFileSync(resolve(repo, 'shared.txt'), 'line B from orphan\n')
    execFileSync('git', ['add', 'shared.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'orphan change'], { cwd: repo })

    const [orphanSha] = logShas(repo)

    // Back on main, make a conflicting change to the same file
    execFileSync('git', ['checkout', 'main'], { cwd: repo })
    writeFileSync(resolve(repo, 'shared.txt'), 'line C from main\n')
    execFileSync('git', ['add', 'shared.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'main change'], { cwd: repo })

    const mainShasBefore = logShas(repo)

    const result = await applyCommitsCherryPick(
      [{ shortSha: orphanSha, subject: 'orphan change' }],
      'main',
      repo,
    )

    expect(result).toEqual({
      ok: false,
      conflictingCommit: { shortSha: orphanSha, subject: 'orphan change' },
    })

    // Working tree is clean after abort (no cherry-pick in progress)
    const status = execSync('git status --porcelain', { cwd: repo })
      .toString()
      .trim()
    expect(status).toBe('')

    // Main has not gained any new commits from the failed cherry-pick
    expect(logShas(repo)).toEqual(mainShasBefore)
  })
})
