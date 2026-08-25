/**
 * Real-git tests for revertAutoCommit (ADR-0100 slice 3).
 *
 * The operator's edits were auto-committed to unblock a merge.  The operator
 * then invokes the revert path to get those edits back as uncommitted working-
 * tree changes so they can be folded into a real commit.
 *
 * Everything runs against a real temp repo because the mechanics depend on
 * git's own index/working-tree split: a stubbed git cannot reproduce the
 * "file shows as unstaged after git reset" behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { revertAutoCommit } from '../operator-auto-commit'

let repoDir: string

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()

const commitFile = (name: string, contents: string, message: string): string => {
  writeFileSync(resolve(repoDir, name), contents)
  git('add', name)
  git('commit', '-m', message)
  return git('rev-parse', 'HEAD')
}

beforeEach(() => {
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-revert-auto-commit-'))

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')

  // Seed: tracked file at its original state.
  commitFile('operator.txt', 'original content', 'seed: initial state')
})

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true })
})

describe('revertAutoCommit', () => {
  it('restores the operator edits as an unstaged modification and leaves history intact', async () => {
    // The auto-commit captured the operator's edit of operator.txt.
    const autoCommitSha = commitFile(
      'operator.txt',
      'PRECIOUS UNCOMMITTED WORK',
      'wip(operator): auto-committed to unblock merge of mars-test',
    )

    const result = await revertAutoCommit({
      repoRoot: repoDir,
      commitSha: autoCommitSha,
      files: ['operator.txt'],
    })

    expect(result).toEqual({ reverted: true })

    // The working tree holds the operator's content.
    const wtContent = execFileSync('cat', [resolve(repoDir, 'operator.txt')], {
      encoding: 'utf8',
    })
    expect(wtContent).toBe('PRECIOUS UNCOMMITTED WORK')

    // The index holds the pre-edit (parent) content — `git show :file` reads
    // the index version.  This is what makes the working-tree content appear as
    // an unstaged modification relative to the index.
    expect(git('show', ':operator.txt')).toBe('original content')

    // `git diff --name-only` lists files whose working tree content differs
    // from the index — i.e. the unstaged changes.  operator.txt must be listed.
    expect(git('diff', '--name-only')).toContain('operator.txt')

    // Note: `git status --porcelain` will show "MM operator.txt":
    //   X='M'  → index (original) differs from HEAD (operator's edits) — index
    //            is "behind" HEAD because we reset it to sha~1.
    //   Y='M'  → working tree (operator's edits) differs from index (original).
    // Both columns are 'M', confirming the working tree has the edits and they
    // are unstaged relative to the index.  The history is not rewritten.

    // The auto-commit is still in the log — history was not rewritten.
    expect(git('log', '--oneline')).toContain(autoCommitSha.slice(0, 7))
    expect(git('log', '--format=%s')).toContain(
      'wip(operator): auto-committed to unblock merge of mars-test',
    )
  })

  it('works correctly when main has moved past the auto-commit (later commits on other files survive intact)', async () => {
    // Auto-commit captures operator's edit of operator.txt.
    const autoCommitSha = commitFile(
      'operator.txt',
      'PRECIOUS UNCOMMITTED WORK',
      'wip(operator): auto-committed to unblock merge of mars-test',
    )

    // Subsequent commits on unrelated files land after the auto-commit — this
    // simulates the normal case where the queue kept moving while the operator
    // was working.
    commitFile('other.txt', 'other work A', 'feat: unrelated work A')
    commitFile('other.txt', 'other work B', 'feat: unrelated work B')

    const result = await revertAutoCommit({
      repoRoot: repoDir,
      commitSha: autoCommitSha,
      files: ['operator.txt'],
    })

    expect(result).toEqual({ reverted: true })

    // The working-tree content of operator.txt is the operator's edit.
    const wtContent = execFileSync('cat', [resolve(repoDir, 'operator.txt')], {
      encoding: 'utf8',
    })
    expect(wtContent).toBe('PRECIOUS UNCOMMITTED WORK')

    // The index holds the pre-edit content — the file is an unstaged modification
    // (git diff --name-only lists it because working tree != index).
    expect(git('show', ':operator.txt')).toBe('original content')
    expect(git('diff', '--name-only')).toContain('operator.txt')

    // The subsequent commits (other.txt) are completely unaffected.
    expect(git('show', 'HEAD:other.txt')).toBe('other work B')
    expect(git('show', 'HEAD~1:other.txt')).toBe('other work A')

    // The auto-commit itself is still in the log.
    const log = git('log', '--format=%s')
    expect(log).toContain('wip(operator): auto-committed to unblock merge of mars-test')
    // Three commits after the seed: auto-commit + two subsequent.
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('4')
  })

  it('returns { reverted: false, reason } when commitSha does not exist in the repo', async () => {
    const bogussha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

    const result = await revertAutoCommit({
      repoRoot: repoDir,
      commitSha: bogussha,
      files: ['operator.txt'],
    })

    expect(result).toEqual({ reverted: false, reason: 'commit not found' })

    // The repo state is completely untouched.
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('')
  })

  it('returns { reverted: false, reason } when files array is empty', async () => {
    const sha = git('rev-parse', 'HEAD')

    const result = await revertAutoCommit({
      repoRoot: repoDir,
      commitSha: sha,
      files: [],
    })

    expect(result).toEqual({ reverted: false, reason: 'no files specified' })
  })
})
