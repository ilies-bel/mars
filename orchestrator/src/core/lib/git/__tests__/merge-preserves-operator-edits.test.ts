/**
 * Real-git regression test: a merge must never destroy uncommitted operator
 * work sitting on the integration checkout.
 *
 * `mergeBranch` Step 3 (`resync-working-tree`) already declines to
 * `git reset --hard` when it sees genuine local changes — "a dirty tree is
 * recoverable where lost edits are not". But the `post-merge-assert` step that
 * runs right after used to see that same dirty tree, fail to tell it apart from
 * dirt left by an interrupted Step 3, and `git reset --hard HEAD` it anyway —
 * silently deleting the operator's edits and undoing Step 3's decision.
 *
 * This happened for real: edits made directly on the integration checkout
 * vanished mid-session, twice, while unrelated tasks merged in the background.
 *
 * The tree still has to end up clean (a dirty integration checkout parks the
 * whole queue behind the dispatch-time dirty-main guard), so the fix stashes
 * rather than resets. We assert both halves: the tree is clean afterwards AND
 * the edit is recoverable from the stash.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { mergeBranch } from '../merge'
import { __resetContextCacheForTests } from '../../../context'

let repoDir: string
let worktreeDir: string
let prevMarsRepo: string | undefined

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()

const commitFile = (name: string, contents: string, message: string): void => {
  writeFileSync(resolve(repoDir, name), contents)
  git('add', name)
  git('commit', '-m', message)
}

beforeAll(() => {
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-preserve-edits-'))
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')

  // c1 on main, plus the file the operator will later edit by hand.
  commitFile('a.txt', 'a', 'c1')
  commitFile('operator.txt', 'original', 'c1b')

  // Task branch adds an unrelated file, so the fast-forward touches only it.
  // It lives in its OWN worktree, exactly as the orchestrator arranges things —
  // the operator's dirty main checkout must not be mistaken for a dirty task
  // worktree by the pre-rebase guard.
  git('branch', 'task/feat')
  worktreeDir = resolve(repoDir, '..', `${repoDir.split('/').pop()}-wt`)
  git('worktree', 'add', worktreeDir, 'task/feat')
  execFileSync('git', ['config', 'user.email', 'test@mars.local'], { cwd: worktreeDir })
  execFileSync('git', ['config', 'user.name', 'Mars Test'], { cwd: worktreeDir })
  writeFileSync(resolve(worktreeDir, 'b.txt'), 'b')
  execFileSync('git', ['add', 'b.txt'], { cwd: worktreeDir })
  execFileSync('git', ['commit', '-m', 'c2'], { cwd: worktreeDir })
})

afterAll(() => {
  if (prevMarsRepo === undefined) delete process.env.MARS_REPO
  else process.env.MARS_REPO = prevMarsRepo
  __resetContextCacheForTests()
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(worktreeDir, { recursive: true, force: true })
})

describe('mergeBranch — uncommitted operator edits on the integration checkout', () => {
  it('preserves the edit via stash instead of resetting it away', async () => {
    // The operator edits a tracked file on main and does not commit.
    writeFileSync(resolve(repoDir, 'operator.txt'), 'PRECIOUS UNCOMMITTED WORK')
    expect(git('status', '--porcelain', '--untracked-files=no')).not.toBe('')

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
    })

    // The merge itself must still land.
    expect(result.aborted).toBe(false)
    expect(git('rev-parse', 'main')).toBe(git('rev-parse', 'task/feat'))

    // The tree must be clean so the dirty-main guard does not park the queue.
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('')

    // ...and the edit must be recoverable, NOT destroyed.
    const stashList = git('stash', 'list')
    expect(stashList).toContain('mars: preserved operator edits')

    git('stash', 'pop')
    expect(readFileSync(resolve(repoDir, 'operator.txt'), 'utf8')).toBe(
      'PRECIOUS UNCOMMITTED WORK',
    )
  }, 60_000)
})
