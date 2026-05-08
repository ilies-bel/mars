import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const initRepo = (path: string): void => {
  execFileSync('git', ['init', '-q', '-b', 'integration'], { cwd: path })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: path })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: path })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: path })
  writeFileSync(resolve(path, 'README'), 'hello\n')
  execFileSync('git', ['add', 'README'], { cwd: path })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: path })
}

const gitOutput = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()

describe('runStructuredWrite (end-to-end against a real temp repo)', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-structured-write-'))
    initRepo(repo)
    process.env.MARS_REPO = repo
    process.env.INTEGRATION_BRANCH = 'integration'
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.INTEGRATION_BRANCH
    rmSync(repo, { recursive: true, force: true })
  })

  it('writes, commits, and merges into the integration branch', async () => {
    const { runStructuredWrite } = await import('../structured-write')

    const outcome = await runStructuredWrite({
      kind: 'glossary',
      commitMessage: 'docs(glossary): add Order term',
      mutate: async (worktreePath) => {
        await writeFile(
          resolve(worktreePath, 'CONTEXT.md'),
          '# Project Context\n\n## Language\n\n**Order**:\nA request to buy something.\n',
          'utf8',
        )
      },
    })

    expect(outcome.kind).toBe('merged')
    if (outcome.kind === 'merged') {
      expect(outcome.conflictResolved).toBe(false)
    }

    // Integration HEAD now contains CONTEXT.md with the expected content.
    const head = gitOutput(repo, ['rev-parse', 'integration'])
    expect(head).toMatch(/^[0-9a-f]{40}$/)

    const fileAtHead = execFileSync(
      'git',
      ['show', 'integration:CONTEXT.md'],
      { cwd: repo, encoding: 'utf8' },
    )
    expect(fileAtHead).toContain('**Order**:')
    expect(fileAtHead).toContain('A request to buy something.')

    // Latest commit message matches what we passed in.
    const subject = gitOutput(repo, ['log', '-1', '--pretty=%s', 'integration'])
    expect(subject).toBe('docs(glossary): add Order term')

    // Worktree was torn down: filesystem path gone and `git worktree list`
    // only reports the main checkout.
    const worktreesDir = resolve(repo, '.mars', 'worktrees')
    if (existsSync(worktreesDir)) {
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(worktreesDir)).toEqual([])
    }
    const worktreeList = gitOutput(repo, ['worktree', 'list', '--porcelain'])
    expect(worktreeList.match(/^worktree /gm) ?? []).toHaveLength(1)

    // Task branch was deleted on cleanup.
    const branches = gitOutput(repo, ['branch', '--list'])
    expect(branches).not.toMatch(/task\/glossary-/)
  })

  it('is a no-op when mutate returns false (no commit, no merge, no leftover branch)', async () => {
    const { runStructuredWrite } = await import('../structured-write')

    const headBefore = gitOutput(repo, ['rev-parse', 'integration'])

    const outcome = await runStructuredWrite({
      kind: 'glossary',
      commitMessage: 'should not be applied',
      mutate: async () => false,
    })

    expect(outcome.kind).toBe('noop')

    const headAfter = gitOutput(repo, ['rev-parse', 'integration'])
    expect(headAfter).toBe(headBefore)

    // No leftover task branch from the aborted write.
    const branches = gitOutput(repo, ['branch', '--list'])
    expect(branches).not.toMatch(/task\/glossary-/)

    // No leftover worktree.
    const worktreeList = gitOutput(repo, ['worktree', 'list', '--porcelain'])
    expect(worktreeList.match(/^worktree /gm) ?? []).toHaveLength(1)
  })
})
