/**
 * Regression test: `mergeBranch` salvage-commits a dirty worktree instead of
 * aborting with `rebase-dirty-worktree`.
 *
 * Incident (agent-infrastructure): a task failed at merge with signature
 * `merge:vcs-supervisor-aborted/rebase-dirty-worktree` because the verify
 * step's `npm install` dirtied `package-lock.json`. Running `mars continue`
 * re-queued the task but could not proceed — it emitted git's own
 * "Please commit your changes or stash them" and the operator had to manually
 * `git add && git commit` the lockfile inside the worktree first.
 *
 * Fix: before entering the rebase loop, `mergeBranch` detects a dirty
 * worktree and auto-commits the outstanding changes under the message
 * `chore(mars): salvage uncommitted verify artifacts`. The rebase then
 * proceeds on a clean tree.
 *
 * Tests (all use real git — no mocks):
 *
 *  1. Dirty worktree is salvage-committed and merge succeeds — the canonical
 *     regression guard: `mars continue` after a verify-dirtied worktree must
 *     not require manual git.
 *
 *  2. The salvage commit's content is correct — `package-lock.json` (the
 *     archetypal artifact from `npm install`) is present on `main` after the
 *     merge.
 *
 *  3. A fully clean worktree still merges without an extra salvage commit —
 *     the happy path is unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { mergeBranch } from '../git/merge'
import { __resetContextCacheForTests } from '../../context'

const GIT = 'git'

const git = (args: string[], cwd: string): string =>
  execFileSync(GIT, args, { cwd, encoding: 'utf8' }).trim()

// ──────────────────────────────────────────────────────────────────────────────
// Shared fixture
//
// Topology (same diverged branch shape used by merge-dirty-tree.test.ts):
//   main:       A → B
//   task/feat:  A → C   (rebased to A → B → C' during the merge)
//
// Between tests we reset main → B and task/feat → C, simulating a fresh
// `mars continue` attempt.
// ──────────────────────────────────────────────────────────────────────────────

interface Fixture {
  primaryRepo: string
  taskWorktree: string
  baseSha: string
  mainExtraSha: string
  taskOrigSha: string
}

let fix: Fixture
let prevMarsRepo: string | undefined

const resetBranches = (f: Fixture): void => {
  execFileSync(GIT, ['checkout', '-q', 'main'], { cwd: f.primaryRepo })
  execFileSync(GIT, ['reset', '--hard', f.mainExtraSha], { cwd: f.primaryRepo })
  execFileSync(GIT, ['reset', '--hard', f.taskOrigSha], { cwd: f.taskWorktree })
  // Remove untracked files and directories from the task worktree so salvage
  // commits from a prior test (e.g. package-lock.json) don't contaminate the
  // next test's dirty-worktree check.
  execFileSync(GIT, ['clean', '-fdq'], { cwd: f.taskWorktree })
}

beforeAll(() => {
  const primaryRepo = mkdtempSync(resolve(tmpdir(), 'mars-salvage-'))

  const g = (args: string[]) =>
    execFileSync(GIT, args, { cwd: primaryRepo, encoding: 'utf8' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 'test@mars.test'])
  g(['config', 'user.name', 'Mars Test'])

  // Commit A — shared base
  writeFileSync(resolve(primaryRepo, 'README'), 'base\n')
  g(['add', 'README'])
  g(['commit', '-q', '-m', 'base'])
  const baseSha = git(['rev-parse', 'main'], primaryRepo)

  // Branch task/feat at A, add commit C
  g(['checkout', '-q', '-b', 'task/feat'])
  writeFileSync(resolve(primaryRepo, 'feature.ts'), 'export const x = 1\n')
  g(['add', 'feature.ts'])
  g(['commit', '-q', '-m', 'feat: add feature'])
  const taskOrigSha = git(['rev-parse', 'task/feat'], primaryRepo)

  // Return to main, add commit B — so the task branch needs a rebase
  g(['checkout', '-q', 'main'])
  writeFileSync(resolve(primaryRepo, 'extra.txt'), 'extra\n')
  g(['add', 'extra.txt'])
  g(['commit', '-q', '-m', 'chore: extra on main'])
  const mainExtraSha = git(['rev-parse', 'main'], primaryRepo)

  // Separate worktree for task/feat (mirrors daemon topology)
  const taskWorktree = mkdtempSync(resolve(tmpdir(), 'mars-salvage-task-'))
  rmSync(taskWorktree, { recursive: true, force: true })
  execFileSync(GIT, ['worktree', 'add', taskWorktree, 'task/feat'], {
    cwd: primaryRepo,
  })
  execFileSync(GIT, ['config', 'user.email', 'test@mars.test'], {
    cwd: taskWorktree,
  })
  execFileSync(GIT, ['config', 'user.name', 'Mars Test'], {
    cwd: taskWorktree,
  })

  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = primaryRepo
  __resetContextCacheForTests()

  fix = { primaryRepo, taskWorktree, baseSha, mainExtraSha, taskOrigSha }
})

afterAll(() => {
  if (prevMarsRepo !== undefined) {
    process.env.MARS_REPO = prevMarsRepo
  } else {
    delete process.env.MARS_REPO
  }
  __resetContextCacheForTests()

  try {
    execFileSync(GIT, ['worktree', 'remove', '--force', fix.taskWorktree], {
      cwd: fix.primaryRepo,
    })
  } catch {
    rmSync(fix.taskWorktree, { recursive: true, force: true })
  }
  rmSync(fix.primaryRepo, { recursive: true, force: true })
})

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('mergeBranch — dirty worktree salvage commit', () => {
  it('salvage-commits a dirty worktree and merges successfully', async () => {
    // Simulate the `mars continue` scenario: the verify step dirtied the
    // worktree (npm install wrote package-lock.json) and the merge is
    // re-attempted with that file still uncommitted.
    resetBranches(fix)

    // Dirty the task worktree with an untracked file — mirrors npm install
    // writing package-lock.json after the verify step.
    writeFileSync(resolve(fix.taskWorktree, 'package-lock.json'), '{"version":1}\n')

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: fix.taskWorktree,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
    })

    // Must succeed — no manual git needed.
    expect(result.merged, `merge output:\n${result.output}`).toBe(true)
    expect(result.aborted).toBe(false)

    // Salvage log line must appear in the output.
    expect(result.output).toContain('[merge:salvage]')
    expect(result.output).toContain('package-lock.json')

    // Primary checkout is clean after merge.
    const statusOutput = git(['status', '--porcelain'], fix.primaryRepo)
    expect(statusOutput).toBe('')
  })

  it('lands the salvage-committed file on main', async () => {
    // Verify that the auto-committed artifact (package-lock.json) is actually
    // present in the merged commit on main — it was not silently dropped.
    resetBranches(fix)

    writeFileSync(
      resolve(fix.taskWorktree, 'package-lock.json'),
      '{"lockfileVersion":3}\n',
    )

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: fix.taskWorktree,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
    })

    expect(result.merged, `merge output:\n${result.output}`).toBe(true)

    const mainSha = git(['rev-parse', 'main'], fix.primaryRepo)
    const filePresent = (() => {
      try {
        execFileSync(GIT, ['cat-file', '-e', `${mainSha}:package-lock.json`], {
          cwd: fix.primaryRepo,
        })
        return true
      } catch {
        return false
      }
    })()
    expect(filePresent, 'package-lock.json must be reachable from main after merge').toBe(true)
  })

  it('clean worktree still merges without a salvage commit', async () => {
    // Happy path: when the worktree is already clean no salvage commit should
    // be created (the merge log must NOT contain the salvage line).
    resetBranches(fix)

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: fix.taskWorktree,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
    })

    expect(result.merged, `merge output:\n${result.output}`).toBe(true)
    expect(result.aborted).toBe(false)
    expect(result.output).not.toContain('[merge:salvage]')
  })
})
