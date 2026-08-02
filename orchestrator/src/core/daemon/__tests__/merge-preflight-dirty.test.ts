/**
 * Behavioral regression tests: dirty merge target does NOT consume recovery budget.
 *
 * SYMPTOM (task mars-04599d9a): recovery task b40205e8 committed correct work on its
 * branch, then failed at the merge step with merge:preflight/uncommitted-changes.
 * Because the old code called handleTaskFailureWithFixTask for the dirty case,
 * the arc's one recovery budget was spent — terminal-failing an arc whose code was
 * correct, just because main happened to be dirty at merge time.
 *
 * FIX: When checkMergeTargetStatus returns 'dirty', the workflow bypasses
 * handleTaskFailureWithFixTask entirely and instead:
 *   1. Sets the task to failed with failedPhase='merge' (preserves branch / committed work).
 *   2. Raises a targeted operator action-queue item with clear operator instructions.
 *   3. Does NOT spawn a fix (recovery) task — the operator resolves it with
 *      `mars continue <id>` once main is clean.
 *
 * These tests verify the observable contract — DB state and action-queue content —
 * without running the full implementWorkflow (which requires Claude subprocess
 * infrastructure not available in unit tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const DIRTY_TARGET_SIGNATURE = 'merge:preflight/uncommitted-changes'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-merge-preflight-dirty-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  // `mars continue` refreshes a parked branch by merging `main`. Seed the
  // fixture with a real commit so that is a valid no-op merge instead of git's
  // "not something we can merge" error from an unborn branch.
  writeFileSync(resolve(repo, 'README.md'), 'fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'initial fixture'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

// ---------------------------------------------------------------------------
// Suite 1 — dirty-target action-queue item; no fix task created
// ---------------------------------------------------------------------------

describe('merge:preflight/uncommitted-changes — recovery budget preserved', () => {
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

  // Timeout: raiseActionQueueItem triggers dynamic imports of large modules
  // (task-store.ts + many dependencies) which can take 3–8 s on a cold Vitest
  // transform pass. 20 s is comfortably above the 99th-percentile wall time.
  it(
    'raises an operator action-queue item, not a fix task, when the merge target is dirty',
    async () => {
      const queue = await import('../../queue')
      await queue.migrateQueueSchema()

      const task = await queue.enqueueTask('implement feature X', undefined, { skipTriage: true })
      await queue.updateTask(task.id, { status: 'merging' })

      // The workflow's dirty-path: updateTask (failed/merge) + raiseActionQueueItem.
      // Critically, handleTaskFailureWithFixTask is NOT called.
      const { raiseActionQueueItem } = await import('../../lib/action-queue')
      const statusOutput =
        'tracked changes on paths the fast-forward would update:\n M orchestrator/src/core/workers/index.ts'

      await queue.updateTask(task.id, {
        status: 'failed',
        error: `merge target ${repo} has uncommitted changes blocking fast-forward\n${statusOutput}`,
        failedPhase: 'merge',
        failureReason: DIRTY_TARGET_SIGNATURE,
        failureReasonCode: DIRTY_TARGET_SIGNATURE,
        failureSignature: DIRTY_TARGET_SIGNATURE,
      })

      await raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: `Merge blocked: main is dirty: orchestrator/src/core/workers/index.ts`,
        body: [
          `Task \`${task.id}\` reached the merge step with committed work on branch \`task/${task.id}\`,`,
          `but the merge target (\`main\`) has uncommitted tracked changes on paths that the fast-forward would update.`,
          '',
          `**To unblock:**`,
          `1. Clean \`main\`: commit the uncommitted changes listed below, or restore the paths you do not want with \`git checkout <ref> -- <paths>\`.`,
          `2. Run \`mars continue ${task.id}\` — this re-attempts just the merge step without re-running the coder.`,
          '',
          '```',
          statusOutput,
          '```',
        ].join('\n'),
        payload: {
          taskId: task.id,
          integrationBranch: 'main',
          targetPath: repo,
          statusOutput,
        },
        context: { repoRoot: repo },
        raisedBy: 'merge:preflight:dirty-target',
        signature: `${task.id}:${DIRTY_TARGET_SIGNATURE}`,
        originTaskId: task.id,
        occurrence: {
          at: new Date().toISOString(),
          taskId: task.id,
          integrationBranch: 'main',
        },
      })

      // ASSERT: no fix (recovery) task was spawned — recovery budget preserved.
      const client = queue.resolveQueueClient()
      const fixTasks = await client.execute({
        sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
        args: [task.id],
      })
      expect(fixTasks.rows).toHaveLength(0)

      // ASSERT: an operator action-queue item was raised with the dirty-target signature.
      const { listActionQueueItems } = await import('../../lib/action-queue')
      const items = await listActionQueueItems('open')
      const dirtyItem = items.find(
        (i) => i.signature === `${task.id}:${DIRTY_TARGET_SIGNATURE}`,
      )
      expect(dirtyItem).toBeDefined()
      expect(dirtyItem!.raisedBy).toBe('merge:preflight:dirty-target')
      expect(dirtyItem!.priority).toBe('high')
      expect(dirtyItem!.kind).toBe('failed')
      expect(dirtyItem!.title).toBe(
        'Merge blocked: main is dirty: orchestrator/src/core/workers/index.ts',
      )
      expect(dirtyItem!.body).toMatch(/mars continue/i)

      // ASSERT: task is in a continue-able state (failed with failedPhase='merge').
      const after = await queue.getTask(task.id)
      expect(after!.status).toBe('failed')
      expect(after!.failedPhase).toBe('merge')
      expect(after!.failureSignature).toBe(DIRTY_TARGET_SIGNATURE)
    },
    20_000,
  )

  it(
    'deduplicates repeated dirty-target items for the same task (idempotent raise)',
    async () => {
      const queue = await import('../../queue')
      await queue.migrateQueueSchema()

      const task = await queue.enqueueTask(
        'repeated merge attempt',
        undefined,
        { skipTriage: true },
      )

      const { raiseActionQueueItem, listActionQueueItems } = await import(
        '../../lib/action-queue'
      )
      const sig = `${task.id}:${DIRTY_TARGET_SIGNATURE}`

      // Raise the same item twice (simulates two merge re-attempts with main still dirty).
      for (let i = 0; i < 2; i++) {
        await raiseActionQueueItem({
          kind: 'failed',
          category: 'orchestrator',
          priority: 'high',
          title: `Merge blocked: main dirty — continue ${task.id}`,
          body: 'Clean main, then mars continue.',
          payload: { taskId: task.id },
          context: { repoRoot: repo },
          raisedBy: 'merge:preflight:dirty-target',
          signature: sig,
          originTaskId: task.id,
          occurrence: {
            at: new Date().toISOString(),
            taskId: task.id,
            integrationBranch: 'main',
          },
        })
      }

      // Only one open row should exist (fingerprint dedup).
      const items = await listActionQueueItems('open')
      const matches = items.filter((i) => i.signature === sig)
      expect(matches).toHaveLength(1)
      expect(matches[0].raisedBy).toBe('merge:preflight:dirty-target')
    },
    20_000,
  )
})

// ---------------------------------------------------------------------------
// Suite 2 — mars continue on merge-failed task preserves branch
// ---------------------------------------------------------------------------

describe('mars continue on merge-failed task', () => {
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

  it('re-queues for merge re-attempt without discarding the committed branch', async () => {
    const queue = await import('../../queue')
    await queue.migrateQueueSchema()

    // Simulate a task that committed work and failed only at the merge step.
    // branch + worktreePath are set (as they would be after setup+code+verify).
    const task = await queue.enqueueTask(
      'committed work; dirty main at merge',
      undefined,
      { skipTriage: true },
    )
    const branch = `task/${task.id}`
    // Use repo itself as a stand-in for the worktreePath (just needs to exist on disk).
    await queue.updateTask(task.id, {
      status: 'failed',
      branch,
      worktreePath: repo,
      failedPhase: 'merge',
      failureSignature: DIRTY_TARGET_SIGNATURE,
    })

    const { coreContinueTask } = await import('../continue-task')
    const result = await coreContinueTask(task.id)

    // ASSERT: NOT degraded to restart — committed work on branch is preserved.
    expect(result.degradedToRestart).toBe(false)

    const after = await queue.getTask(task.id)
    // Task is queued for the next dispatch (which re-enters at the merge step
    // via engine checkpoint-resume on runId=task.id).
    expect(after!.status).toBe('queued')
    // Branch is preserved — the committed work is still accessible.
    expect(after!.branch).toBe(branch)
  }, 15_000)

  it(
    'keeps recovery-task branch intact on continue (regression: b40205e8 scenario)',
    async () => {
      // Regression: recovery task b40205e8 committed correct work but was
      // terminal-failed at merge because main was dirty. Verify that if the
      // same scenario happens — a recovery (fix) task reaches merge/failed with
      // a dirty target — mars continue preserves its branch instead of restarting.
      const queue = await import('../../queue')
      await queue.migrateQueueSchema()

      // Create the origin task and a recovery (fix) task pointing at it.
      const origin = await queue.enqueueTask(
        'original failing work',
        undefined,
        { skipTriage: true },
      )
      await queue.updateTask(origin.id, { status: 'failed' })

      const client = queue.resolveQueueClient()

      // Insert a fix task (simulates what handleTaskFailureWithFixTask would create).
      const fixId = `fix-${origin.id.slice(0, 8)}`
      const fixBranch = `task/${fixId}`
      await client.execute({
        sql: `INSERT INTO tasks (id, prompt, status, kind, fix_for_task_id, origin_id, branch, worktree_path, created_at, updated_at)
              VALUES (?, 'fix the work', 'failed', 'fix', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        args: [fixId, origin.id, origin.id, fixBranch, repo],
      })
      await client.execute({
        sql: `UPDATE tasks SET failed_phase = 'merge', failure_signature = ? WHERE id = ?`,
        args: [DIRTY_TARGET_SIGNATURE, fixId],
      })

      // mars continue on the fix task: should re-queue with branch preserved.
      const { coreContinueTask } = await import('../continue-task')
      const result = await coreContinueTask(fixId)

      expect(result.degradedToRestart).toBe(false)

      const afterFix = await queue.getTask(fixId)
      expect(afterFix!.status).toBe('queued')
      expect(afterFix!.branch).toBe(fixBranch)
    },
    15_000,
  )
})

// ---------------------------------------------------------------------------
// Suite 3 — checkMergeTargetStatus correctly classifies a dirty integration
//           root without modifying it (the workflow turns this result into the
//           action-queue row above before mergeBranch can run).
// ---------------------------------------------------------------------------

describe('checkMergeTargetStatus — dirty integration root', () => {
  let repo: string

  beforeEach(() => {
    repo = makeRepo()
    // Set up a git repo where task/x is one commit ahead of main on file A.
    writeFileSync(resolve(repo, 'A'), 'a0\n')
    execFileSync('git', ['add', 'A'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', '-b', 'task/x'], { cwd: repo })
    writeFileSync(resolve(repo, 'A'), 'a1\n')
    execFileSync('git', ['commit', '-q', '-am', 'task edit on A'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it(
    'reports the dirty path without resetting away uncommitted operator changes',
    async () => {
      // This is the exact scenario from the incident: an uncommitted edit in
      // the integration checkout while a task branch is ready to merge.
      writeFileSync(resolve(repo, 'A'), 'a-dirty\n')

      const { checkMergeTargetStatus } = await import('../../lib/git/merge')
      const status = await checkMergeTargetStatus({
        integrationBranch: 'main',
        taskBranch: 'task/x',
      })

      expect(status.kind).toBe('dirty')
      if (status.kind === 'dirty') {
        expect(status.statusOutput).toContain(' M A')
      }
      // The preflight is read-only: it must never use reset/checkout to make
      // its answer convenient. The merge primitive stops on this result and
      // raises the actionable row asserted above.
      expect(readFileSync(resolve(repo, 'A'), 'utf8')).toBe('a-dirty\n')
      expect(
        execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
          cwd: repo,
          encoding: 'utf8',
        }),
      ).toContain(' M A')
    },
    15_000,
  )

  it(
    'returns clean when uncommitted changes are on non-overlapping paths',
    async () => {
      // An uncommitted edit on a file (B) that the fast-forward would NOT touch
      // must NOT block the merge — that would be an over-broad dirty check.
      writeFileSync(resolve(repo, 'B'), 'b-dirty\n')
      // Leave B unstaged/untracked — `--untracked-files=no` means git status
      // would omit it regardless. The key is it's not on path A.

      const { checkMergeTargetStatus } = await import('../../lib/git/merge')
      const status = await checkMergeTargetStatus({
        integrationBranch: 'main',
        taskBranch: 'task/x',
      })

      // B is not touched by the fast-forward, so the preflight should not block.
      expect(status.kind).toBe('clean')
    },
    15_000,
  )
})
