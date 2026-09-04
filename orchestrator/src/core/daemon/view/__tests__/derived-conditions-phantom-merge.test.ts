/**
 * Tests for the phantom-merge derived condition.
 *
 * The condition predicate now checks live git state rather than relying solely
 * on the tombstone's null mergeCommitSha. Three outcomes are possible:
 *
 * - `landed`  — branch / checkpoint refs exist and are patch-present on the
 *               integration branch → no alert raised.
 * - `missing` — evidence exists but is NOT on the integration branch →
 *               raises `phantom-merge` (high priority).
 * - `unknown` — no surviving branch or checkpoint refs → raises
 *               `phantom-merge-unknown` (normal priority) instead of
 *               asserting commits are missing.
 *
 * All three are covered below.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createConditionItemsSource } from '../derived-conditions.js'
import type { DbClient, DbStatement } from '../../../lib/db.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a temporary git repo with a single commit on `main`. */
function makeRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-pm-test-'))
  execFileSync('git', ['init', '-b', 'main', '-q', dir])
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd: dir })
  return dir
}

/** Write a file, stage, and commit it. Returns the commit SHA. */
function commit(repo: string, filename: string, content: string, message: string): string {
  writeFileSync(join(repo, filename), content)
  execFileSync('git', ['add', filename], { cwd: repo })
  execFileSync('git', [
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=Test',
    'commit', '-m', message, '-q',
  ], { cwd: repo })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
}

/** Write a tombstone with reason=merged and null mergeCommitSha for `taskId`. */
function writeTombstone(repo: string, taskId: string, opts: { removedAt?: string } = {}): void {
  const dir = join(repo, '.mars', 'worktrees')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${taskId}.removed.json`),
    JSON.stringify({
      taskId,
      branch: `task/${taskId}`,
      reason: 'merged',
      mergeCommitSha: null,
      ...(opts.removedAt !== undefined ? { removedAt: opts.removedAt } : {}),
    }),
  )
}

/**
 * A mock DbClient that returns a fixed list of done-task ids for the
 * phantom-merge query and empty rows for everything else.
 */
function makeDbClient(doneTaskIds: string[]): DbClient {
  return {
    execute: async (stmt: DbStatement) => {
      const sql = typeof stmt === 'string' ? stmt : stmt.sql
      if (sql.includes("status = 'done'")) {
        return { rows: doneTaskIds.map((id) => ({ id })), rowsAffected: 0 }
      }
      return { rows: [], rowsAffected: 0 }
    },
    batch: async () => [],
    close: async () => {},
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe(
  'derivePhantomMergeConditions — git state checks',
  { timeout: 30_000 },
  () => {
    let repo: string

    beforeEach(() => {
      repo = makeRepo()
      process.env.INTEGRATION_BRANCH = 'main'
    })

    afterEach(() => {
      delete process.env.INTEGRATION_BRANCH
      rmSync(repo, { recursive: true, force: true })
    })

    // ── Case 1: checkpoint ref IS reachable → no alert ───────────────────────

    it('raises nothing when a checkpoint ref is patch-present on the integration branch', async () => {
      const taskId = 'mars-test-landed'

      // Commit some work directly to main (simulating the recovery task landing it)
      commit(repo, `${taskId}-work.txt`, 'the work\n', `feat: work for ${taskId}`)

      // Create a checkpoint ref pointing at a commit whose patch is on main.
      // We use the same SHA that's now on main as the checkpoint.
      const mainSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim()
      execFileSync(
        'git',
        ['update-ref', `refs/mars/checkpoint/${taskId}-${mainSha.slice(0, 9)}`, mainSha],
        { cwd: repo },
      )

      writeTombstone(repo, taskId)

      const source = createConditionItemsSource({
        getClient: () => makeDbClient([taskId]),
        repoRoot: repo,
        nowMs: Date.now(),
      })

      const rows = await source.derive({ kinds: new Set(['phantom-merge', 'phantom-merge-unknown']) })
      expect(rows).toHaveLength(0)
    })

    // ── Case 2: checkpoint ref exists but NOT on main → phantom-merge ────────

    it('raises phantom-merge when a checkpoint ref exists but its patch is not on the integration branch', async () => {
      const taskId = 'mars-test-missing'

      // Create an orphan commit that is NOT merged into main.
      // We do this by making a commit, capturing its SHA, then resetting HEAD
      // so the commit is unreachable from main but the ref still exists.
      const sha = commit(repo, `${taskId}-work.txt`, 'unmerged work\n', `feat: ${taskId} work`)
      // Reset main back one commit so sha is no longer on main.
      execFileSync('git', ['reset', '--hard', 'HEAD~1', '-q'], { cwd: repo })

      execFileSync(
        'git',
        ['update-ref', `refs/mars/checkpoint/${taskId}-${sha.slice(0, 9)}`, sha],
        { cwd: repo },
      )

      writeTombstone(repo, taskId)

      const source = createConditionItemsSource({
        getClient: () => makeDbClient([taskId]),
        repoRoot: repo,
        nowMs: Date.now(),
      })

      const rows = await source.derive({ kinds: new Set(['phantom-merge', 'phantom-merge-unknown']) })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.kind).toBe('phantom-merge')
      expect(rows[0]!.priority).toBe('high')
      expect(rows[0]!.payload['taskId']).toBe(taskId)
    })

    // ── Case 3: no surviving evidence → phantom-merge-unknown ────────────────

    it('raises phantom-merge-unknown (normal priority) when no branch or checkpoint refs survive', async () => {
      const taskId = 'mars-test-unknown'

      // No branch, no checkpoint refs — just a tombstone.
      writeTombstone(repo, taskId)

      const source = createConditionItemsSource({
        getClient: () => makeDbClient([taskId]),
        repoRoot: repo,
        nowMs: Date.now(),
      })

      const rows = await source.derive({ kinds: new Set(['phantom-merge', 'phantom-merge-unknown']) })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.kind).toBe('phantom-merge-unknown')
      expect(rows[0]!.priority).toBe('normal')
      expect(rows[0]!.payload['taskId']).toBe(taskId)
    })

    // ── Case 4: task branch still exists and is on main → no alert ──────────

    it('raises nothing when the task branch exists and all its commits are on the integration branch', async () => {
      const taskId = 'mars-test-branch-landed'

      // Create the task branch, commit to it, then merge it into main.
      execFileSync('git', ['checkout', '-b', `task/${taskId}`, '-q'], { cwd: repo })
      commit(repo, `${taskId}.txt`, 'task work\n', `feat(${taskId}): implement`)
      execFileSync('git', ['checkout', 'main', '-q'], { cwd: repo })
      execFileSync('git', ['merge', `task/${taskId}`, '--no-ff', '-m', `merge ${taskId}`, '-q'], {
        cwd: repo,
      })
      // Branch still exists (not deleted yet) — simulates pre-cleanup state.

      writeTombstone(repo, taskId)

      const source = createConditionItemsSource({
        getClient: () => makeDbClient([taskId]),
        repoRoot: repo,
        nowMs: Date.now(),
      })

      const rows = await source.derive({ kinds: new Set(['phantom-merge', 'phantom-merge-unknown']) })
      expect(rows).toHaveLength(0)
    })

    // ── Case 5: task branch exists but has unmerged commits → phantom-merge ──

    it('raises phantom-merge when the task branch exists but has commits not yet on the integration branch', async () => {
      const taskId = 'mars-test-branch-missing'

      execFileSync('git', ['checkout', '-b', `task/${taskId}`, '-q'], { cwd: repo })
      commit(repo, `${taskId}.txt`, 'unmerged task work\n', `feat(${taskId}): wip`)
      execFileSync('git', ['checkout', 'main', '-q'], { cwd: repo })
      // NOT merging — the branch has commits that main doesn't.

      writeTombstone(repo, taskId)

      const source = createConditionItemsSource({
        getClient: () => makeDbClient([taskId]),
        repoRoot: repo,
        nowMs: Date.now(),
      })

      const rows = await source.derive({ kinds: new Set(['phantom-merge', 'phantom-merge-unknown']) })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.kind).toBe('phantom-merge')
      expect(rows[0]!.priority).toBe('high')
    })

    // ── Case 6: no tombstone → no alert (pre-existing behaviour) ─────────────

    it('raises nothing when the task has no tombstone', async () => {
      const taskId = 'mars-test-no-tombstone'
      // No tombstone written — just the task in the DB.

      const source = createConditionItemsSource({
        getClient: () => makeDbClient([taskId]),
        repoRoot: repo,
        nowMs: Date.now(),
      })

      const rows = await source.derive({ kinds: new Set(['phantom-merge', 'phantom-merge-unknown']) })
      expect(rows).toHaveLength(0)
    })

    // ── Case 7: raisedAt comes from tombstone.removedAt, not nowMs ────────────

    it('uses the tombstone removedAt timestamp as raisedAt, not the derivation time', async () => {
      const taskId = 'mars-test-timestamp'
      const removedAt = '2026-01-15T08:30:00.000Z'
      const expectedMs = Date.parse(removedAt) // 1736929800000

      // Write tombstone with a known removedAt in the past.
      writeTombstone(repo, taskId, { removedAt })

      const nowMs = Date.now() // current time, well after removedAt
      const source = createConditionItemsSource({
        getClient: () => makeDbClient([taskId]),
        repoRoot: repo,
        nowMs,
      })

      const rows = await source.derive({ kinds: new Set(['phantom-merge', 'phantom-merge-unknown']) })
      expect(rows).toHaveLength(1)
      // The alert's raisedAt must reflect when the merge occurred (tombstone
      // removedAt), not the query time — so the UI shows the real age instead
      // of "0s ago" on every refresh.
      expect(rows[0]!.raisedAt).toBe(expectedMs)
      expect(rows[0]!.raisedAt).not.toBe(nowMs)
    })
  },
)
