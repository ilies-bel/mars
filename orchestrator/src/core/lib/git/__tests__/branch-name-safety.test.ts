/**
 * Branch-name construction safety test (ADR-0048 / 2026-08-05 incident).
 *
 * The `preserve/adr-0048-slice4-alert-thread` orphan showed that a recovery
 * agent committed real feature work onto a freeform branch name invented by the
 * LLM. The orchestrator's OWN branch-name construction must ALWAYS use the
 * `task/<id>` namespace — never `preserve/*`, `fix/*`, `wip/*`, or any other
 * free-form prefix.
 *
 * This test verifies the behaviour through the public interface of
 * `createWorktree`: whatever internal branch-construction logic it uses, the
 * result must start with `task/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createWorktree } from '../worktree'
import { __resetContextCacheForTests } from '../../../context'

let repo: string
let prevMarsRepo: string | undefined

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-branch-safety-'))
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

describe('createWorktree — branch name must always be task/<id>', () => {
  it('returns a branch name in the task/ namespace for a plain taskId', async () => {
    const ref = await createWorktree({
      taskId: 'mars-abc123',
      integrationBranch: 'main',
    })
    expect(ref.branch).toBe('task/mars-abc123')
    expect(ref.branch).toMatch(/^task\//)
  })

  it('returns a branch name in the task/ namespace when a branchSuffix is given', async () => {
    const ref = await createWorktree({
      taskId: 'mars-def456',
      integrationBranch: 'main',
      branchSuffix: 'retry2',
    })
    // Still starts with task/, suffix is appended after the id.
    expect(ref.branch).toMatch(/^task\//)
    expect(ref.branch).toContain('mars-def456')
  })

  it('never constructs a preserve/, wip/, or fix/ branch name', async () => {
    const ref = await createWorktree({
      taskId: 'mars-ghi789',
      integrationBranch: 'main',
    })
    expect(ref.branch).not.toMatch(/^preserve\//)
    expect(ref.branch).not.toMatch(/^wip\//)
    expect(ref.branch).not.toMatch(/^fix\//)
  })

  it('the worktree HEAD branch matches the returned branch name', async () => {
    const ref = await createWorktree({
      taskId: 'mars-jkl012',
      integrationBranch: 'main',
    })
    const headBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ref.path })
      .toString()
      .trim()
    expect(headBranch).toBe(ref.branch)
    expect(headBranch).toMatch(/^task\//)
  })
}, 60_000)
