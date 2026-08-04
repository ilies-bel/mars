/**
 * Integration tests for commitMain against a real git repo.
 *
 * These tests verify the fix for the 2026-07-20 data-loss incident where
 * the main-committer used `git commit -am`, which silently drops new
 * untracked files. commitMain uses `git add -A` so every file — modified
 * tracked AND newly created untracked — ends up in the commit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { autoCommitWorktreeIfDeterministic, commitMain } from './commit-main'

/** Create a temp git repo on `main` with a single tracked file and initial commit. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-commit-main-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'tracked.txt'), 'initial content\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return repo
}

/** Return all file names tracked by the HEAD commit tree (committed files, not working tree). */
const headCommitTree = (repo: string): string[] =>
  execSync('git ls-tree --name-only -r HEAD', { cwd: repo })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)

/** Return the file names recorded in the HEAD commit (excluding empty lines). */
const headCommitFiles = (repo: string): string[] =>
  execSync('git show --name-only --format= HEAD', { cwd: repo })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)

describe('commitMain', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('stages and commits a new untracked file alongside a tracked modification', async () => {
    // Modify the tracked file — git commit -am would stage this.
    writeFileSync(resolve(repo, 'tracked.txt'), 'modified content\n')

    // Create a brand-new file that has never been added — git commit -am
    // would silently skip this, which was the root cause of the incident.
    writeFileSync(resolve(repo, 'new-module.ts'), 'export const x = 1\n')

    await commitMain({ cwd: repo, message: 'chore: both files must land' })

    const files = headCommitFiles(repo)
    expect(files).toContain('tracked.txt')
    expect(files).toContain('new-module.ts')
  })

  it('returns the SHA of the new commit', async () => {
    writeFileSync(resolve(repo, 'another.txt'), 'content\n')

    const { sha } = await commitMain({ cwd: repo, message: 'test: sha verification' })

    const headSha = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
    expect(sha).toBe(headSha)
  })

  it('throws when there is nothing to commit', async () => {
    // The tree is clean after setupRepo — git commit exits non-zero.
    await expect(commitMain({ cwd: repo, message: 'empty' })).rejects.toThrow()
  })

  it('does NOT stage files listed in .gitignore', async () => {
    // The task brief calls out .gitignore as the safety valve: git add -A
    // respects .gitignore, so scratch files / secrets / build artefacts
    // covered by .gitignore entries are never accidentally committed.
    writeFileSync(resolve(repo, '.gitignore'), 'secret.env\n')
    writeFileSync(resolve(repo, 'secret.env'), 'API_KEY=do-not-commit\n')
    // Add a legitimate new file so the commit is non-empty.
    writeFileSync(resolve(repo, 'legit.ts'), 'export const x = 1\n')

    await commitMain({ cwd: repo, message: 'chore: .gitignore boundary test' })

    const tree = headCommitTree(repo)
    expect(tree).toContain('.gitignore')
    expect(tree).toContain('legit.ts')
    expect(tree).not.toContain('secret.env')
  })
})

describe('autoCommitWorktreeIfDeterministic', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('records coder-left-dirty and committer-salvage provenance accurately', async () => {
    writeFileSync(resolve(repo, 'coder-work.ts'), 'export const coderWork = true\n')

    await autoCommitWorktreeIfDeterministic({
      taskId: 'coder-task',
      provenance: 'coder-left-dirty',
      integrationBranch: 'main',
      worktreePath: repo,
      dirtyFiles: ['coder-work.ts'],
    })

    const coderMessage = execSync('git log -1 --format=%B', { cwd: repo }).toString()
    expect(coderMessage).toContain(
      'chore(auto-commit): task coder-task — coder finished but did not commit — 1 path(s)',
    )
    expect(coderMessage).toContain(
      'The coder for task coder-task ended the code step with 1 path(s) still',
    )

    writeFileSync(resolve(repo, 'salvaged-work.ts'), 'export const salvagedWork = true\n')

    await autoCommitWorktreeIfDeterministic({
      taskId: 'committer-task',
      provenance: 'committer-salvage',
      integrationBranch: 'release/2026-08',
      worktreePath: repo,
      dirtyFiles: ['salvaged-work.ts'],
    })

    const salvageMessage = execSync('git log -1 --format=%B', { cwd: repo }).toString()
    expect(salvageMessage).toContain('release/2026-08')
    expect(salvageMessage.toLowerCase()).not.toContain('coder')
    expect(salvageMessage).not.toContain('code step')
    expect(salvageMessage).toContain('Authorship is unknown')
  })
})
