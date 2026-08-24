/**
 * Tests for `mergeBranch`'s pre-rebase dirty-worktree hygiene guard.
 *
 * History: mergeBranch briefly salvage-committed a dirty task worktree
 * (`chore(mars): salvage uncommitted verify artifacts`) before rebasing.
 * That behaviour was deliberately REVERSED (commit 2a68d8ec, "fix(merge):
 * abort on dirty worktree before rebase"): silently committing whatever a
 * verify step or a crashed coder left behind could land unreviewed artifacts
 * on `main`. The merge now detects the dirty worktree BEFORE `git rebase`
 * runs and aborts with a distinct `worktree dirty before rebase` output, so
 * the failure-signature classifier routes to `rebase-dirty-worktree`
 * (resolution: the salvage/checkpoint machinery on the recovery path — see
 * `checkpoint.ts` — not an in-merge auto-commit) instead of spawning Vega
 * with a false-premise prompt.
 *
 * Tests (all use real git — no mocks):
 *
 *  1. Dirty worktree aborts the merge before the rebase, naming the dirty
 *     path; `main` is not advanced.
 *
 *  2. A clean worktree still merges normally.
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
// Between tests we reset main → B and task/feat → C.
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
  // Remove untracked files and directories from the task worktree so dirt
  // from a prior test (e.g. package-lock.json) doesn't contaminate the next
  // test's dirty-worktree check.
  execFileSync(GIT, ['clean', '-fdq'], { cwd: f.taskWorktree })
}

beforeAll(() => {
  const primaryRepo = mkdtempSync(resolve(tmpdir(), 'mars-salvage-'))

  const g = (args: string[]) =>
    execFileSync(GIT, args, { cwd: primaryRepo, encoding: 'utf8' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 'test@mars.test'])
  g(['config', 'user.name', 'Mars Test'])

  // Commit A — shared base. `.mars/` gitignored as in every real consumer
  // repo (the merge step records `.mars/last-synced-sha` after its re-sync).
  writeFileSync(resolve(primaryRepo, '.gitignore'), '.mars/\n')
  writeFileSync(resolve(primaryRepo, 'README'), 'base\n')
  g(['add', '.gitignore', 'README'])
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

describe('mergeBranch — pre-rebase dirty-worktree guard', () => {
  it('aborts before the rebase when the task worktree is dirty, naming the dirty path', async () => {
    // The verify step (npm install) dirtied the worktree with an untracked
    // package-lock.json; the merge must refuse rather than silently
    // committing an unreviewed artifact.
    resetBranches(fix)

    writeFileSync(resolve(fix.taskWorktree, 'package-lock.json'), '{"version":1}\n')

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: fix.taskWorktree,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
    })

    expect(result.merged, `merge output:\n${result.output}`).toBe(false)
    expect(result.aborted).toBe(true)
    // The abort output names the guard and the offending path so the
    // failure-signature classifier can route to rebase-dirty-worktree.
    expect(result.output).toContain('worktree dirty before rebase')
    expect(result.output).toContain('package-lock.json')
    // No salvage commit is ever created by the merge itself.
    expect(result.output).not.toContain('[merge:salvage]')

    // main did NOT advance — nothing was rebased or fast-forwarded.
    expect(git(['rev-parse', 'main'], fix.primaryRepo)).toBe(fix.mainExtraSha)
    // The dirty file is left in place for the recovery path to handle.
    const wtStatus = git(['status', '--porcelain'], fix.taskWorktree)
    expect(wtStatus).toContain('package-lock.json')
  })

  it('clean worktree still merges normally', async () => {
    resetBranches(fix)

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: fix.taskWorktree,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
    })

    expect(result.merged, `merge output:\n${result.output}`).toBe(true)
    expect(result.aborted).toBe(false)

    // The feature commit landed on main and the primary checkout is clean.
    const mainSha = git(['rev-parse', 'main'], fix.primaryRepo)
    execFileSync(GIT, ['cat-file', '-e', `${mainSha}:feature.ts`], {
      cwd: fix.primaryRepo,
    })
    expect(git(['status', '--porcelain'], fix.primaryRepo)).toBe('')
  })
})
