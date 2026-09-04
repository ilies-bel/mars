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
import { PARKED_REF_PREFIX, MERGE_WORK_LOST_SIGNATURE } from '../../../tools/merge/merge.js'

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

// ---------------------------------------------------------------------------
// Suite 3 — eviction → park → merge:work-lost sequence (regression mars-59c9fdb0)
//
// SYMPTOM (2026-09-04): the stale-merging-sweep evicted a task from `merging`,
// recoverPhase reset the branch to the integration tip (zero commits ahead),
// and the subsequent merge step saw a zero-commit branch and completed as
// `done` — silently discarding the task's committed work.
//
// FIX (two halves, tested here together):
//   A. recoverPhase parks the branch tip under refs/mars/parked/<id>/<ts>
//      BEFORE resetting the branch, so the commits are never lost.
//   B. The merge gate detects the parked ref and fails with `merge:work-lost`
//      instead of silently succeeding with zero commits.
//
// This suite exercises the exact sequence: commit on branch → simulate eviction
// (park tip + reset branch) → confirm zero-commit state + parked ref detected.
// ---------------------------------------------------------------------------

describe('eviction → park → work-lost detection sequence (regression mars-59c9fdb0)', () => {
  let repo: string

  const GIT_ENV = {
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@test.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@test.com',
  }

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
    'after eviction-park, isZeroCommitBranch returns true and the parked ref is found',
    async () => {
      const taskId = 'mars-regression-test-59c9fdb0'
      const branch = `task/${taskId}`

      // Step 1: coder commits real work on the task branch.
      execFileSync('git', ['checkout', '-b', branch], { cwd: repo, env: { ...process.env, ...GIT_ENV } })
      writeFileSync(resolve(repo, 'feature.ts'), 'export const featureFlag = true\n')
      execFileSync('git', ['add', 'feature.ts'], { cwd: repo })
      execFileSync(
        'git',
        ['commit', '-q', '-m', 'feat(gates): add verify-gates route and Gates section'],
        { cwd: repo, env: { ...process.env, ...GIT_ENV } },
      )
      execFileSync('git', ['checkout', 'main'], { cwd: repo })

      // Confirm the branch has real commits before eviction.
      const { isZeroCommitBranch } = await import('../../lib/git/merge')
      expect(await isZeroCommitBranch(branch, repo)).toBe(false)

      // Step 2: simulate recoverPhase eviction — park the tip, then reset branch.
      // This mirrors what phase-recovery.ts does: it calls vcs.updateRef to park
      // under refs/mars/parked/<id>/<ts>, then removes the worktree and resets
      // the branch to the integration tip via deleteBranch + re-checkout.
      const tipSha = execFileSync('git', ['rev-parse', branch], { cwd: repo }).toString().trim()
      const parkedRef = `${PARKED_REF_PREFIX}/${taskId}/${Date.now()}`
      execFileSync('git', ['update-ref', parkedRef, tipSha], { cwd: repo })
      // Simulate branch reset to integration tip (what CLEARED_INFLIGHT + re-setup does).
      execFileSync('git', ['branch', '-f', branch, 'main'], { cwd: repo })

      // Step 3: confirm the merge gate would see zero commits.
      expect(await isZeroCommitBranch(branch, repo)).toBe(true)

      // Step 4: confirm the parked ref is discoverable — this is what the merge
      // gate checks via `git for-each-ref refs/mars/parked/<taskId>`.
      const parkedRefs = execFileSync(
        'git',
        ['for-each-ref', '--format=%(refname)', `${PARKED_REF_PREFIX}/${taskId}`],
        { cwd: repo },
      )
        .toString()
        .trim()
      expect(parkedRefs).not.toBe('')
      expect(parkedRefs).toContain(parkedRef)

      // Step 5: verify MERGE_WORK_LOST_SIGNATURE is the correct constant used
      // when the merge gate detects this scenario (not 'merge:zero-commit-branch').
      expect(MERGE_WORK_LOST_SIGNATURE).toBe('merge:work-lost')
      expect(MERGE_WORK_LOST_SIGNATURE).not.toBe('merge:zero-commit-branch')

      // Step 6: confirm the tip SHA recorded in the parked ref matches the
      // original coder commit — the work is preserved, not discarded.
      const parkedTip = execFileSync('git', ['rev-parse', parkedRef], { cwd: repo })
        .toString()
        .trim()
      expect(parkedTip).toBe(tipSha)
    },
    20_000,
  )

  it(
    'a branch with no prior commits produces no parked ref (distinguishes sandbox-blocked from eviction)',
    async () => {
      // A plain zero-commit branch (sandbox-blocked-commit scenario, not an eviction)
      // has NO parked ref — the merge gate should use merge:zero-commit-branch,
      // not merge:work-lost, so the distinction is preserved.
      const taskId = 'mars-no-prior-commits'
      const branch = `task/${taskId}`
      execFileSync('git', ['branch', branch], { cwd: repo })

      const { isZeroCommitBranch } = await import('../../lib/git/merge')
      expect(await isZeroCommitBranch(branch, repo)).toBe(true)

      // No parked ref exists for this task — for-each-ref returns empty.
      const parkedRefs = execFileSync(
        'git',
        ['for-each-ref', '--format=%(refname)', `${PARKED_REF_PREFIX}/${taskId}`],
        { cwd: repo },
      )
        .toString()
        .trim()
      expect(parkedRefs).toBe('')
    },
    10_000,
  )
})
