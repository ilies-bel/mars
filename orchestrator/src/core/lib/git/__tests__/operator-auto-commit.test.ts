/**
 * Real-git tests for the operator auto-commit path (ADR-0100 slice 6).
 *
 * When the operator has genuine uncommitted edits on the integration checkout
 * and a merge needs to land, Mars commits them for the operator as
 * `wip(operator): auto-committed to unblock merge of <task>` and the queue
 * keeps moving. With the `operatorAutoCommit` lever off, the pre-existing
 * behaviour stands: nothing is committed and the edits are preserved on a
 * checkpoint ref for the operator to recover.
 *
 * Everything runs against a real temp repo with a real task worktree, because
 * the whole hazard here is git's own behaviour: the fast-forward moves
 * `refs/heads/main` without touching the checkout, so the stale index reports
 * the just-merged file as a staged DELETION. A stubbed git cannot show that,
 * and a `git add -u` implementation that looks perfectly correct in a stub
 * deletes the merged work in a real repo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { mergeBranch, operatorWipCommitMessage, type OperatorAutoCommitInfo } from '../merge'
import { nullTraceStore } from '../../run-tool'
import { __resetContextCacheForTests } from '../../../context'

const TASK_ID = 'mars-t35tid'

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

beforeEach(() => {
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-operator-auto-commit-'))
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')

  commitFile('a.txt', 'a', 'c1')
  commitFile('operator.txt', 'original', 'c1b')

  // The task branch adds an unrelated file from its own worktree, exactly as
  // the orchestrator arranges things.
  git('branch', 'task/feat')
  worktreeDir = resolve(repoDir, '..', `${repoDir.split('/').pop()}-wt`)
  git('worktree', 'add', worktreeDir, 'task/feat')
  execFileSync('git', ['config', 'user.email', 'test@mars.local'], { cwd: worktreeDir })
  execFileSync('git', ['config', 'user.name', 'Mars Test'], { cwd: worktreeDir })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: worktreeDir })
  writeFileSync(resolve(worktreeDir, 'b.txt'), 'merged content')
  execFileSync('git', ['add', 'b.txt'], { cwd: worktreeDir })
  execFileSync('git', ['commit', '-m', 'c2'], { cwd: worktreeDir })
})

afterEach(() => {
  if (prevMarsRepo === undefined) delete process.env.MARS_REPO
  else process.env.MARS_REPO = prevMarsRepo
  __resetContextCacheForTests()
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(worktreeDir, { recursive: true, force: true })
})

describe('mergeBranch — operator dirt with the auto-commit lever ON', () => {
  it('commits the operator edits, reports the sha, and leaves the tree clean', async () => {
    // The operator edits a tracked file and leaves an untracked scratch file.
    writeFileSync(resolve(repoDir, 'operator.txt'), 'PRECIOUS UNCOMMITTED WORK')
    writeFileSync(resolve(repoDir, 'scratch.txt'), 'not mine to commit')

    const reported: OperatorAutoCommitInfo[] = []
    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
      // Lever on is the default; state it so the test says which case it is.
      autoCommitOperatorDirt: true,
      onOperatorAutoCommit: (info) => {
        reported.push(info)
      },
      traceCtx: { taskId: TASK_ID, store: nullTraceStore },
    })

    expect(result.merged).toBe(true)
    expect(result.aborted).toBe(false)

    // The commit subject is the operator-visible contract, verbatim.
    expect(git('log', '-1', '--format=%s', 'main')).toBe(operatorWipCommitMessage(TASK_ID))

    // It carries the operator's content and only the operator's content: the
    // merged file the stale checkout was missing is NOT deleted by it.
    const head = git('rev-parse', 'main')
    expect(result.operatorAutoCommitSha).toBe(head)
    expect(git('show', '--name-only', '--format=', head).split('\n').filter(Boolean)).toEqual([
      'operator.txt',
    ])
    expect(git('show', `${head}:b.txt`)).toBe('merged content')
    expect(git('show', `${head}:operator.txt`)).toBe('PRECIOUS UNCOMMITTED WORK')

    // The merge itself landed underneath it — which is also what makes a
    // concurrent merge redo: `main` is no longer the tip it CAS-checked, so
    // its fast-forward is refused and re-rebased rather than clobbering this.
    expect(git('rev-parse', 'main^')).toBe(git('rev-parse', 'task/feat'))

    // The checkout is clean and current, so the dirty-main guard does not park
    // the queue, and the merged file is materialised on disk.
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(readFileSync(resolve(repoDir, 'b.txt'), 'utf8')).toBe('merged content')
    expect(readFileSync(resolve(repoDir, 'operator.txt'), 'utf8')).toBe(
      'PRECIOUS UNCOMMITTED WORK',
    )

    // The untracked scratch file is untouched and still untracked.
    expect(existsSync(resolve(repoDir, 'scratch.txt'))).toBe(true)
    expect(readFileSync(resolve(repoDir, 'scratch.txt'), 'utf8')).toBe('not mine to commit')
    // (`.mars/` is the merge lock's own directory, untracked by construction.)
    expect(git('status', '--porcelain').split('\n')).toContain('?? scratch.txt')

    // The Notice's evidence: the sha it names and the paths it claims.
    expect(reported).toHaveLength(1)
    expect(reported[0]?.commitSha).toBe(head)
    expect(reported[0]?.files).toEqual(['operator.txt'])

    // Nothing needed preserving, so no checkpoint ref was written.
    expect(git('for-each-ref', '--format=%(refname)', 'refs/mars/checkpoint')).toBe('')
  }, 60_000)
})

describe('mergeBranch — operator dirt with the auto-commit lever OFF', () => {
  it('commits nothing and preserves the edits on a checkpoint ref instead', async () => {
    writeFileSync(resolve(repoDir, 'operator.txt'), 'PRECIOUS UNCOMMITTED WORK')

    const reported: OperatorAutoCommitInfo[] = []
    const result = await mergeBranch({
      branch: 'task/feat',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 30_000,
      autoCommitOperatorDirt: false,
      onOperatorAutoCommit: (info) => {
        reported.push(info)
      },
      traceCtx: { taskId: TASK_ID, store: nullTraceStore },
    })

    expect(result.aborted).toBe(false)
    expect(result.operatorAutoCommitSha).toBeUndefined()
    expect(reported).toEqual([])

    // No wip(operator) commit anywhere: main is exactly the merged tip.
    expect(git('rev-parse', 'main')).toBe(git('rev-parse', 'task/feat'))
    expect(git('log', '-1', '--format=%s', 'main')).not.toBe(operatorWipCommitMessage(TASK_ID))

    // The pre-existing behaviour stands: the edit survives on a checkpoint ref.
    const refs = git('for-each-ref', '--format=%(refname)', 'refs/mars/checkpoint')
      .split('\n')
      .filter((line) => line.length > 0)
    expect(refs).toHaveLength(1)
    git('cherry-pick', '-n', refs[0] as string)
    expect(readFileSync(resolve(repoDir, 'operator.txt'), 'utf8')).toBe(
      'PRECIOUS UNCOMMITTED WORK',
    )
  }, 60_000)
})
