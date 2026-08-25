/**
 * End-to-end acceptance test: the operator auto-commit path produces a
 * revertible Notice (ADR-0100 slice 6, DEC-3).
 *
 * Proves the full vertical in one test:
 *   1. mergeBranch auto-commits genuine operator dirt as a wip(operator) commit
 *   2. The onOperatorAutoCommit callback receives a notice payload that carries
 *      commitSha and files (the two pieces the revert verb needs)
 *   3. Calling revertAutoCommit with those pieces restores the operator's edits
 *      as an unstaged working-tree modification, history intact
 *   4. The revert succeeds even after main has moved past the auto-commit
 *      (at least one more commit landed before the revert was invoked)
 *
 * Everything runs against a real temp repo because both auto-commit and
 * revert depend on git's own working-tree/index split; stubs cannot show that.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { mergeBranch, type OperatorAutoCommitInfo } from '../merge'
import { revertAutoCommit } from '../operator-auto-commit'
import { nullTraceStore } from '../../run-tool'
import { __resetContextCacheForTests } from '../../../context'

const TASK_ID = 'mars-e2e-revert'

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
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-auto-commit-e2e-'))
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')

  // Two tracked files on main: a.txt (unrelated) and operator.txt (the file
  // the operator will edit, triggering the auto-commit path).
  commitFile('a.txt', 'initial', 'seed: a')
  commitFile('operator.txt', 'original', 'seed: operator file')

  // Task branch: adds b.txt (a different file, no overlap with operator.txt),
  // set up in its own worktree exactly as the orchestrator arranges things.
  git('branch', 'task/e2e')
  worktreeDir = resolve(repoDir, '..', `${repoDir.split('/').pop() ?? 'wt'}-wt`)
  git('worktree', 'add', worktreeDir, 'task/e2e')
  execFileSync('git', ['config', 'user.email', 'test@mars.local'], { cwd: worktreeDir })
  execFileSync('git', ['config', 'user.name', 'Mars Test'], { cwd: worktreeDir })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: worktreeDir })
  writeFileSync(resolve(worktreeDir, 'b.txt'), 'merged content')
  execFileSync('git', ['add', 'b.txt'], { cwd: worktreeDir })
  execFileSync('git', ['commit', '-m', 'feat: add b.txt'], { cwd: worktreeDir })
})

afterEach(() => {
  if (prevMarsRepo === undefined) delete process.env.MARS_REPO
  else process.env.MARS_REPO = prevMarsRepo
  __resetContextCacheForTests()
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(worktreeDir, { recursive: true, force: true })
})

describe('auto-commit Notice carries a working revert — DEC-3 acceptance', () => {
  it(
    'auto-commits operator dirt, notice payload has commitSha+files, revert restores unstaged edits with history intact even after main moved',
    async () => {
      // The operator edits a tracked file on main without committing — this
      // is the "operator dirt" the auto-commit lever exists to handle.
      writeFileSync(resolve(repoDir, 'operator.txt'), 'PRECIOUS UNCOMMITTED WORK')

      // Step 1: trigger the merge with the auto-commit lever ON.
      // Capture the notice payload from the onOperatorAutoCommit callback.
      const captured: OperatorAutoCommitInfo[] = []
      const result = await mergeBranch({
        branch: 'task/e2e',
        worktreePath: worktreeDir,
        integrationBranch: 'main',
        lockTimeoutMs: 30_000,
        autoCommitOperatorDirt: true,
        onOperatorAutoCommit: (info) => {
          captured.push(info)
        },
        traceCtx: { taskId: TASK_ID, store: nullTraceStore },
      })

      expect(result.merged).toBe(true)
      expect(result.aborted).toBe(false)

      // Step 2: the notice payload must include commitSha and files.
      // These are the two pieces the revert verb uses to restore the edits.
      expect(captured).toHaveLength(1)
      const noticePayload = captured[0]!
      expect(typeof noticePayload.commitSha).toBe('string')
      expect(noticePayload.commitSha).toHaveLength(40)
      expect(noticePayload.files).toEqual(['operator.txt'])

      const { commitSha, files } = noticePayload

      // The auto-commit is the current tip of main right after the merge.
      expect(result.operatorAutoCommitSha).toBe(commitSha)
      expect(git('rev-parse', 'main')).toBe(commitSha)
      expect(git('log', '-1', '--format=%s', 'main')).toMatch(
        /^wip\(operator\): auto-committed to unblock merge of /,
      )

      // Step 3: land a further commit on main AFTER the auto-commit.
      // This proves the revert is resilient to main having moved past the
      // auto-commit sha (the common case: the queue kept running).
      commitFile('extra.txt', 'extra work', 'chore: work after auto-commit')
      const laterCommitSha = git('rev-parse', 'main')
      expect(laterCommitSha).not.toBe(commitSha)

      // Step 4: invoke revertAutoCommit using the commitSha and files from the
      // notice payload — exactly what the revert HTTP endpoint would do.
      const revertResult = await revertAutoCommit({ repoRoot: repoDir, commitSha, files })
      expect(revertResult).toEqual({ reverted: true })

      // Step 5: the operator's file must appear as an UNSTAGED modification.
      //   - Working tree holds their precious content.
      //   - Index holds the pre-edit (parent commit) content.
      //   - `git diff --name-only` (WT vs index) must list operator.txt.
      const wtContent = readFileSync(resolve(repoDir, 'operator.txt'), 'utf8')
      expect(wtContent).toBe('PRECIOUS UNCOMMITTED WORK')
      expect(git('diff', '--name-only')).toContain('operator.txt')

      // Step 6: the auto-commit is still in the log — history was NOT rewritten.
      const log = git('log', '--oneline')
      expect(log).toContain(commitSha.slice(0, 7))
      expect(git('log', '--format=%s')).toContain(
        `wip(operator): auto-committed to unblock merge of ${TASK_ID}`,
      )

      // Step 7: the commit that landed after the auto-commit is fully intact.
      expect(git('rev-parse', 'main')).toBe(laterCommitSha)
      expect(git('show', 'HEAD:extra.txt')).toBe('extra work')
    },
    60_000,
  )
})
