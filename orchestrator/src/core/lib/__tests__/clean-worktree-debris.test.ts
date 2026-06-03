import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { cleanWorktreeIfNoCommitsAhead } from '../git/verify'

/**
 * Build a fixture repo that mimics a task worktree:
 *  - `main` has a single commit and a `.gitignore` that excludes `.mars/`
 *    and `node_modules/` (matching the real repo).
 *  - The repo's HEAD is then on `task/X` branched from `main` — the
 *    caller controls whether to add commits ahead of `main` and which
 *    debris to drop into the worktree.
 */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-clean-debris-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  writeFileSync(
    resolve(repo, '.gitignore'),
    '.mars/\nnode_modules/\n',
  )
  writeFileSync(resolve(repo, 'README'), 'hello\n')
  execFileSync('git', ['add', '.gitignore', 'README'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['checkout', '-q', '-b', 'task/X', 'main'], { cwd: repo })
  return repo
}

const writeDebris = (repo: string): void => {
  // Mirror the bug example: a wrongly-nested file under an
  // `orchestrator/orchestrator/` path that the previous agent wrote but
  // never staged.
  mkdirSync(resolve(repo, 'orchestrator', 'orchestrator'), { recursive: true })
  writeFileSync(
    resolve(repo, 'orchestrator', 'orchestrator', 'test.ts'),
    'export const wrong = true\n',
  )
  // A second, bare-top-level untracked file to prove the sweep is not
  // path-specific.
  writeFileSync(resolve(repo, 'leftover.tmp'), 'noise\n')
}

const seedMarsState = (repo: string): void => {
  // The orchestrator state lives at `.mars/` and is gitignored. The
  // clean step MUST preserve everything underneath it, regardless of
  // whether the branch is ahead.
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  writeFileSync(resolve(repo, '.mars', 'queue.db'), 'queue-state-bytes')
  writeFileSync(resolve(repo, '.mars', '.merge.lock'), String(process.pid))
}

describe('cleanWorktreeIfNoCommitsAhead', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('removes untracked debris when the branch is 0 commits ahead of integration', async () => {
    writeDebris(repo)
    seedMarsState(repo)

    expect(existsSync(resolve(repo, 'orchestrator', 'orchestrator', 'test.ts')))
      .toBe(true)
    expect(existsSync(resolve(repo, 'leftover.tmp'))).toBe(true)

    const result = await cleanWorktreeIfNoCommitsAhead({
      worktreePath: repo,
      integrationBranch: 'main',
    })

    expect(result.cleaned).toBe(true)
    expect(result.reason).toContain('0 commits ahead')
    expect(existsSync(resolve(repo, 'orchestrator', 'orchestrator', 'test.ts')))
      .toBe(false)
    expect(existsSync(resolve(repo, 'orchestrator', 'orchestrator'))).toBe(false)
    expect(existsSync(resolve(repo, 'leftover.tmp'))).toBe(false)
    // README is tracked — clean must not touch it.
    expect(readFileSync(resolve(repo, 'README'), 'utf8')).toBe('hello\n')
    // .mars/ contents preserved (gitignored, no -x).
    expect(existsSync(resolve(repo, '.mars', 'queue.db'))).toBe(true)
    expect(readFileSync(resolve(repo, '.mars', 'queue.db'), 'utf8'))
      .toBe('queue-state-bytes')
    expect(existsSync(resolve(repo, '.mars', '.merge.lock'))).toBe(true)
  })

  it('skips the clean when the branch is >=1 commit ahead of integration', async () => {
    // Commit some real work on task/X so the branch is 1 commit ahead.
    writeFileSync(resolve(repo, 'real-work.ts'), 'export const ok = true\n')
    execFileSync('git', ['add', 'real-work.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'feat: real work'], { cwd: repo })

    // Now also drop debris and seed .mars state.
    writeDebris(repo)
    seedMarsState(repo)

    const result = await cleanWorktreeIfNoCommitsAhead({
      worktreePath: repo,
      integrationBranch: 'main',
    })

    expect(result.cleaned).toBe(false)
    expect(result.reason).toContain('1 commit(s) ahead')
    expect(result.reason).toContain('preserving worktree state')
    // Debris still there — we don't touch worktrees with committed work,
    // even if the work-in-progress is messy.
    expect(existsSync(resolve(repo, 'orchestrator', 'orchestrator', 'test.ts')))
      .toBe(true)
    expect(existsSync(resolve(repo, 'leftover.tmp'))).toBe(true)
    // .mars/ contents preserved either way.
    expect(existsSync(resolve(repo, '.mars', 'queue.db'))).toBe(true)
    expect(readFileSync(resolve(repo, '.mars', 'queue.db'), 'utf8'))
      .toBe('queue-state-bytes')
  })

  it('preserves .mars/ when running the cleanup even if .mars/ contains an untracked tree', async () => {
    // Explicit coverage of verification (3): .mars/ contents survive
    // the clean even though they're untracked, because .gitignore lists
    // them and we omit `-x`.
    seedMarsState(repo)
    writeDebris(repo)

    const result = await cleanWorktreeIfNoCommitsAhead({
      worktreePath: repo,
      integrationBranch: 'main',
    })

    expect(result.cleaned).toBe(true)
    expect(existsSync(resolve(repo, '.mars'))).toBe(true)
    expect(existsSync(resolve(repo, '.mars', 'queue.db'))).toBe(true)
    expect(existsSync(resolve(repo, '.mars', '.merge.lock'))).toBe(true)
  })

  it('returns cleaned=false with a structured reason when rev-list fails', async () => {
    const result = await cleanWorktreeIfNoCommitsAhead({
      worktreePath: repo,
      integrationBranch: 'does-not-exist',
    })

    expect(result.cleaned).toBe(false)
    expect(result.reason).toContain('rev-list')
    expect(result.reason).toContain('does-not-exist')
  })
})
