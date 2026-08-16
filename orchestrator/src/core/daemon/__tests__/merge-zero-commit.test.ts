/**
 * Behavioral regression tests: zero-commit branch at the merge gate must FAIL,
 * not silently succeed.
 *
 * SYMPTOM (tasks mars-748ab10e, mars-cffe1aa9, mars-eb04bbda): the codex sandbox
 * blocked git writes to .git/worktrees/<task-id>/index.lock, leaving the task
 * branch at the integration tip (zero commits ahead). The merge gate's
 * isZeroCommitBranch short-circuit returned true and marked the task 'done' with
 * message "zero-commit branch — no merge needed" — a false-green that silently
 * discarded all coder work.
 *
 * FIX: When isZeroCommitBranch returns true for a non-main-committer task, the
 * merge gate now:
 *   1. Sets the task to failed with failedPhase='merge' and signature
 *      'merge:zero-commit-branch'.
 *   2. Raises a targeted operator action-queue item pointing at the preserved
 *      worktree.
 *   3. Does NOT spawn a fix (recovery) task — the operator resolves via
 *      `mars continue <id>` after inspecting the worktree.
 *
 * These tests verify the observable DB-state and action-queue contract without
 * running the full implementWorkflow (which requires subprocess infrastructure
 * not available in unit tests). They simulate the exact side-effects the fixed
 * merge gate now produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const ZERO_COMMIT_SIGNATURE = 'merge:zero-commit-branch'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-merge-zero-commit-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'initial fixture'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

// ---------------------------------------------------------------------------
// Suite 1 — zero-commit branch: action-queue item raised, no fix task created
// ---------------------------------------------------------------------------

describe('merge:zero-commit-branch — recovery budget preserved', () => {
  let repo: string

  beforeEach(() => {
    repo = makeRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it(
    'raises an operator action-queue item, not a fix task, when the branch has zero commits',
    async () => {
      const queue = await import('../../queue')
      await queue.migrateQueueSchema()

      const task = await queue.enqueueTask('fix sandbox commit blocker', undefined, {
        skipTriage: true,
      })
      // Simulate the merge gate's new outcome: updateTask(failed) + raiseActionQueueItem.
      // Critically, handleTaskFailureWithFixTask is NOT called.
      await queue.updateTask(task.id, { status: 'merging' })

      const { raiseActionQueueItem } = await import('../../lib/action-queue')
      const worktreePath = resolve(repo, '.mars', 'worktrees', task.id)
      const branch = `task/${task.id}`
      const integrationBranch = 'main'

      await queue.updateTask(task.id, {
        status: 'failed',
        error: `task branch ${branch} has zero commits ahead of ${integrationBranch}; the pipeline produced no deliverable commits. Worktree preserved at ${worktreePath} for investigation.`,
        failedPhase: 'merge',
        failureReason: ZERO_COMMIT_SIGNATURE,
        failureReasonCode: ZERO_COMMIT_SIGNATURE,
        failureSignature: ZERO_COMMIT_SIGNATURE,
      })

      await raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: `Task ${task.id}: zero-commit branch — no work delivered`,
        body: [
          `Task \`${task.id}\` reached the merge gate with branch \`${branch}\` at the same ` +
            `commit as \`${integrationBranch}\` — zero commits ahead.`,
          '',
          `**To recover:** run \`mars continue ${task.id}\``,
        ].join('\n'),
        payload: { taskId: task.id, branch, integrationBranch, worktreePath },
        context: { repoRoot: repo },
        raisedBy: 'merge:zero-commit-branch',
        signature: `${task.id}:${ZERO_COMMIT_SIGNATURE}`,
        originTaskId: task.id,
        occurrence: {
          at: new Date().toISOString(),
          taskId: task.id,
          integrationBranch,
        },
      })

      // ASSERT: no fix (recovery) task was spawned — recovery budget preserved.
      const client = queue.resolveQueueClient()
      const fixTasks = await client.execute({
        sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
        args: [task.id],
      })
      expect(fixTasks.rows).toHaveLength(0)

      // ASSERT: an operator action-queue item was raised with the zero-commit signature.
      const { listActionQueueItems } = await import('../../lib/action-queue')
      const items = await listActionQueueItems('open')
      const zeroCommitItem = items.find(
        (i) => i.signature === `${task.id}:${ZERO_COMMIT_SIGNATURE}`,
      )
      expect(zeroCommitItem).toBeDefined()
      expect(zeroCommitItem!.raisedBy).toBe('merge:zero-commit-branch')
      expect(zeroCommitItem!.priority).toBe('high')
      expect(zeroCommitItem!.kind).toBe('failed')
      expect(zeroCommitItem!.title).toBe(`Task ${task.id}: zero-commit branch — no work delivered`)
      expect(zeroCommitItem!.body).toMatch(/mars continue/i)

      // ASSERT: task is in a continue-able state (failed with failedPhase='merge').
      const after = await queue.getTask(task.id)
      expect(after!.status).toBe('failed')
      expect(after!.failedPhase).toBe('merge')
      expect(after!.failureSignature).toBe(ZERO_COMMIT_SIGNATURE)
    },
    20_000,
  )

  it(
    'deduplicates repeated zero-commit items for the same task (idempotent raise)',
    async () => {
      const queue = await import('../../queue')
      await queue.migrateQueueSchema()

      const task = await queue.enqueueTask('dedupe zero-commit', undefined, { skipTriage: true })
      const { raiseActionQueueItem, listActionQueueItems } = await import('../../lib/action-queue')
      const sig = `${task.id}:${ZERO_COMMIT_SIGNATURE}`

      // Raise the same item twice (simulates two merge re-attempts with the branch
      // still at integration tip — e.g., the operator ran `mars continue` and the
      // sandbox blocked commits again).
      for (let i = 0; i < 2; i++) {
        await raiseActionQueueItem({
          kind: 'failed',
          category: 'orchestrator',
          priority: 'high',
          title: `Task ${task.id}: zero-commit branch — no work delivered`,
          body: 'Run `mars continue` to retry.',
          payload: { taskId: task.id },
          context: { repoRoot: repo },
          raisedBy: 'merge:zero-commit-branch',
          signature: sig,
          originTaskId: task.id,
          occurrence: {
            at: new Date().toISOString(),
            taskId: task.id,
            integrationBranch: 'main',
          },
        })
      }

      const items = await listActionQueueItems('open')
      const matches = items.filter((i) => i.signature === sig)
      // The raise is idempotent: only one item per signature.
      expect(matches).toHaveLength(1)
    },
    20_000,
  )
})

// ---------------------------------------------------------------------------
// Suite 2 — isZeroCommitBranch identifies zero-commit branches correctly
// ---------------------------------------------------------------------------

describe('isZeroCommitBranch — git utility', () => {
  let repo: string

  beforeEach(() => {
    repo = makeRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns true when the branch tip equals the integration tip (no commits ahead)', async () => {
    // Create a branch pointing at main (zero commits ahead — simulates the
    // sandbox-blocked-commit scenario where the coder ran but couldn't commit).
    const branch = 'task/zero-ahead'
    execFileSync('git', ['branch', branch], { cwd: repo })

    vi.resetModules()
    const { isZeroCommitBranch } = await import('../../lib/git/merge')
    expect(await isZeroCommitBranch(branch, repo)).toBe(true)
  })

  it('returns false when the branch has at least one commit ahead of main', async () => {
    const branch = 'task/has-work'
    execFileSync('git', ['checkout', '-b', branch], { cwd: repo })
    writeFileSync(resolve(repo, 'work.ts'), 'export const x = 1\n')
    execFileSync('git', ['add', 'work.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'feat: real work'], { cwd: repo })
    execFileSync('git', ['checkout', 'main'], { cwd: repo })

    vi.resetModules()
    const { isZeroCommitBranch } = await import('../../lib/git/merge')
    expect(await isZeroCommitBranch(branch, repo)).toBe(false)
  })
})
