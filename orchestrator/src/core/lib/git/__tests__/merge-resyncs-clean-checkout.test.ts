/**
 * Real-git regression test for `mergeBranch`'s Step 3 resync (ADR-0100
 * slice 5): after a successful CAS fast-forward, a clean integration
 * checkout must stay boring — resync the tree to the merged content, leave
 * `git status` empty, and record the new `lastSyncedSha`. There is no
 * checkpoint machinery left to over-trigger: Step 3 is a plain
 * `git reset --hard <newHead>`, gated only by `attributeIntegrationDirt` for
 * any dirt found beforehand (covered separately by
 * `stale-tree-attribution.test.ts` and `operator-auto-commit`'s own tests).
 * This test pins the trivial, all-clean case so a future change to that
 * gating cannot silently start leaving debris — or a checkpoint ref — behind
 * on an ordinary merge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { mergeBranch } from '../merge'
import { __resetContextCacheForTests } from '../../../context'

let repoDir: string
let worktreeDir: string
let prevMarsRepo: string | undefined

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()

beforeAll(() => {
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-clean-resync-'))
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')

  writeFileSync(resolve(repoDir, 'a.txt'), 'a')
  git('add', 'a.txt')
  git('commit', '-m', 'c1')

  // The task branch lives in its own worktree, as the orchestrator arranges it,
  // and adds a file the integration checkout has never seen.
  git('branch', 'task/feat')
  worktreeDir = resolve(repoDir, '..', `${repoDir.split('/').pop()}-wt`)
  git('worktree', 'add', worktreeDir, 'task/feat')
  execFileSync('git', ['config', 'user.email', 'test@mars.local'], { cwd: worktreeDir })
  execFileSync('git', ['config', 'user.name', 'Mars Test'], { cwd: worktreeDir })
  writeFileSync(resolve(worktreeDir, 'b.txt'), 'merged content')
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

describe('mergeBranch — clean integration checkout', () => {
  it('resyncs the tree to the merged content without leaving a checkpoint ref', async () => {
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(existsSync(resolve(repoDir, 'b.txt'))).toBe(false)

    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
    })

    expect(result.aborted).toBe(false)
    expect(result.merged).toBe(true)
    expect(git('rev-parse', 'main')).toBe(git('rev-parse', 'task/feat'))

    // The working tree materialises the merged content and stays clean, so the
    // dispatch-time dirty-main guard does not park the queue.
    expect(readFileSync(resolve(repoDir, 'b.txt'), 'utf8')).toBe('merged content')
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('')

    // Nothing was displaced, so nothing was preserved.
    expect(
      git('for-each-ref', '--format=%(refname)', 'refs/mars/checkpoint'),
    ).toBe('')
  }, 60_000)
})
