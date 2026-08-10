/**
 * Tests for commit-message validation and repair.
 *
 * Regression driver: commit 15f91328 reached main with a 176-character subject
 * where two words were fused ("multiplexerstypecheck") and item 1 of a bulleted
 * list was collapsed into the subject — the agent passed a multi-line `-m`
 * argument without preserving separators. The repair gate must catch this before
 * fast-forward.
 *
 * Test structure:
 *  A. Pure `repairCommitMessage` logic — no git repo needed.
 *  B. Real-git `repairBranchCommitMessages` — uses a temporary git repo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  repairCommitMessage,
  repairBranchCommitMessages,
  SUBJECT_MAX_LEN,
  truncateAtWordBoundary,
} from '../git/commit-message'
import { __resetContextCacheForTests } from '../../context'

// ---------------------------------------------------------------------------
// A. Pure logic — repairCommitMessage
// ---------------------------------------------------------------------------

describe('repairCommitMessage — pure logic', () => {
  it('passes a conforming message through byte-identical', () => {
    const msg = 'fix(auth): validate token expiry before dispatch'
    const { message, repaired } = repairCommitMessage(msg)
    expect(repaired).toBe(false)
    expect(message).toBe(msg)
  })

  it('passes a conforming message with a proper body byte-identical', () => {
    const msg = [
      'feat(queue): drain blocked tasks on blocker settlement',
      '',
      'When a blocker transitions to done or dropped, the dependent',
      'tasks are flipped to queued and the dispatch loop is nudged.',
    ].join('\n')
    const { message, repaired } = repairCommitMessage(msg)
    expect(repaired).toBe(false)
    expect(message).toBe(msg)
  })

  it('truncates an over-limit subject at a word boundary, not mid-word', () => {
    // 80-char subject — must truncate at the last space ≤72
    const subject = 'fix(merge): add post-fast-forward ancestry assertion to prevent silent no-ops'
    expect(subject.length).toBeGreaterThan(SUBJECT_MAX_LEN)

    const { message, repaired, reason } = repairCommitMessage(subject)
    expect(repaired).toBe(true)
    expect(reason).toContain('truncated')

    const newSubject = message.split('\n')[0]
    // Subject must not exceed limit
    expect(newSubject.length).toBeLessThanOrEqual(SUBJECT_MAX_LEN)
    // Must not end mid-word: the character immediately after the subject in
    // the ORIGINAL string at position newSubject.length must be a space (or
    // the subject equals the whole original — ruled out here).
    const charAfter = subject[newSubject.length]
    expect(charAfter).toBe(' ')
    // Overflow must be in the body, separated by a blank line.
    const parts = message.split('\n\n')
    expect(parts.length).toBeGreaterThanOrEqual(2)
  })

  it('moves overflow text to body and preserves all content', () => {
    const subject = 'chore(ci): add template-sync-check job that re-runs mars bundle refresh and fails on drift'
    expect(subject.length).toBeGreaterThan(SUBJECT_MAX_LEN)

    const { message, repaired } = repairCommitMessage(subject)
    expect(repaired).toBe(true)

    const [subjectLine, , ...bodyLines] = message.split('\n')
    const body = bodyLines.join('\n')

    // No content is lost: subject + body should cover all words in the original.
    const originalWords = new Set(subject.split(/\s+/))
    const repairedWords = new Set(
      (subjectLine + ' ' + body).split(/\s+/).filter(Boolean),
    )
    for (const word of originalWords) {
      expect(repairedWords.has(word)).toBe(true)
    }
  })

  it('repairs the exact 15f91328 subject — fused words, 176 chars', () => {
    // This is the real subject that reached main in commit 15f91328.
    // The agent collapsed a multi-line message, fusing "bare\nmultiplexers"
    // into "baremultiplexerstypecheck".
    const badSubject =
      'fix(verify): support -- separator in verify add, guard ' +
      'baremultiplexerstypecheck that runs bare npx always passes without ' +
      'checking    anything — strictly worse than no gate.'

    expect(badSubject.length).toBeGreaterThan(SUBJECT_MAX_LEN)

    const { message, repaired } = repairCommitMessage(badSubject)
    expect(repaired).toBe(true)

    const lines = message.split('\n')
    const newSubject = lines[0]

    // Subject must be within limit
    expect(newSubject.length).toBeLessThanOrEqual(SUBJECT_MAX_LEN)
    // Subject must not end mid-word — the character right after it in the
    // original string should be a space (or the truncation point IS a space).
    expect(badSubject[newSubject.length]).toBe(' ')
    // The fused fragment must appear in the body (not silently dropped).
    expect(message).toContain('baremultiplexerstypecheck')
    // Blank line between subject and body
    expect(lines[1]).toBe('')
  })

  it('adds a blank-line separator when body is attached directly to subject', () => {
    const msg = 'fix: handle null ref in queue\nThis was causing a crash on startup.'
    const { message, repaired } = repairCommitMessage(msg)
    expect(repaired).toBe(true)
    const parts = message.split('\n')
    expect(parts[0]).toBe('fix: handle null ref in queue')
    expect(parts[1]).toBe('') // blank separator
    expect(parts[2]).toBe('This was causing a crash on startup.')
  })

  it('does not duplicate the blank-line separator when it is already present', () => {
    const msg = 'fix: handle null ref\n\nThis was the body.'
    const { message, repaired } = repairCommitMessage(msg)
    // No structural change needed
    expect(repaired).toBe(false)
    expect(message).toBe(msg)
  })
})

// ---------------------------------------------------------------------------
// truncateAtWordBoundary edge cases
// ---------------------------------------------------------------------------

describe('truncateAtWordBoundary', () => {
  it('returns the string unchanged when it is within the limit', () => {
    expect(truncateAtWordBoundary('short', 72)).toBe('short')
  })

  it('truncates at the last space before the limit', () => {
    const s = 'hello world this is a long string that goes past the limit at some point now'
    const result = truncateAtWordBoundary(s, 30)
    expect(result.length).toBeLessThanOrEqual(30)
    // Must not end mid-word
    expect(s[result.length]).toBe(' ')
  })

  it('hard-truncates when no space exists within the limit', () => {
    const s = 'a'.repeat(100)
    const result = truncateAtWordBoundary(s, 72)
    expect(result.length).toBe(72)
    expect(result).toBe('a'.repeat(72))
  })
})

// ---------------------------------------------------------------------------
// B. Real-git repairBranchCommitMessages
// ---------------------------------------------------------------------------

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

interface Fixture {
  primaryRepo: string
  taskWorktree: string
  mainSha: string
}

let fixture: Fixture

beforeAll(() => {
  // Create a bare-ish primary repo
  const primaryRepo = mkdtempSync(resolve(tmpdir(), 'mars-test-commit-msg-'))
  git(['init', '-b', 'main'], primaryRepo)
  git(['config', 'user.email', 'test@mars'], primaryRepo)
  git(['config', 'user.name', 'Mars Test'], primaryRepo)

  // Initial commit on main
  writeFileSync(resolve(primaryRepo, 'base.txt'), 'base')
  git(['add', '.'], primaryRepo)
  git(['commit', '-m', 'chore: initial commit'], primaryRepo)
  const mainSha = git(['rev-parse', 'HEAD'], primaryRepo)

  // Create a task branch from main
  git(['checkout', '-b', 'task/test'], primaryRepo)

  // Add a commit with a conforming message
  writeFileSync(resolve(primaryRepo, 'file-a.txt'), 'a')
  git(['add', '.'], primaryRepo)
  git(['commit', '-m', 'feat(api): add file-a'], primaryRepo)

  // Add a commit with a long (non-conforming) subject
  writeFileSync(resolve(primaryRepo, 'file-b.txt'), 'b')
  git(['add', '.'], primaryRepo)
  git(
    [
      'commit',
      '-m',
      'fix(verify): support -- separator in verify add, guard baremultiplexerstypecheck that runs bare npx always passes without checking anything',
    ],
    primaryRepo,
  )

  // Switch back to main for the worktree
  git(['checkout', 'main'], primaryRepo)

  // Create a separate worktree for the task branch
  const taskWorktree = mkdtempSync(resolve(tmpdir(), 'mars-test-task-wt-'))
  rmSync(taskWorktree, { recursive: true })
  git(['worktree', 'add', taskWorktree, 'task/test'], primaryRepo)

  // Point MARS_REPO at the primary repo so repoRoot() resolves correctly.
  process.env.MARS_REPO = primaryRepo
  __resetContextCacheForTests()

  fixture = { primaryRepo, taskWorktree, mainSha }
})

afterAll(() => {
  if (!fixture) return
  try {
    git(['worktree', 'remove', '--force', fixture.taskWorktree], fixture.primaryRepo)
  } catch {}
  rmSync(fixture.taskWorktree, { recursive: true, force: true })
  rmSync(fixture.primaryRepo, { recursive: true, force: true })
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

describe('repairBranchCommitMessages — real git', () => {
  it('repairs a non-conforming subject and updates the branch tip', async () => {
    const { primaryRepo, taskWorktree } = fixture

    const tipBefore = git(['rev-parse', 'task/test'], primaryRepo)

    const result = await repairBranchCommitMessages(
      'task/test',
      'main',
      taskWorktree,
    )

    // One commit needed repair (the long subject); the conforming one did not.
    expect(result.repairedCount).toBe(1)
    expect(result.repairs).toHaveLength(1)
    expect(result.repairs[0].reason).toContain('truncated')

    // Branch tip must change (new commit SHA due to rewritten message).
    const tipAfter = git(['rev-parse', 'task/test'], primaryRepo)
    expect(tipAfter).not.toBe(tipBefore)

    // Inspect the rewritten commit message on the branch.
    const newSubject = git(['log', '--format=%s', '-1', 'task/test'], primaryRepo)
    expect(newSubject.length).toBeLessThanOrEqual(SUBJECT_MAX_LEN)
  })

  it('leaves a conforming subject byte-identical', async () => {
    const { primaryRepo, taskWorktree } = fixture

    // After the previous test already repaired the bad commit, both commits
    // on task/test should now be conforming. A second repair pass is a no-op.
    const tipBefore = git(['rev-parse', 'task/test'], primaryRepo)
    const result = await repairBranchCommitMessages(
      'task/test',
      'main',
      taskWorktree,
    )

    expect(result.repairedCount).toBe(0)
    expect(result.repairs).toHaveLength(0)

    // Tip must not change.
    const tipAfter = git(['rev-parse', 'task/test'], primaryRepo)
    expect(tipAfter).toBe(tipBefore)
  })
})
