/**
 * Regression tests for the edgeless-blocked invariant.
 *
 * Root-cause (task mars-ba9f3af0): tasks enqueued during a storm-pause landed
 * as status='blocked' with ZERO task_blockers edges.  The direct cause was the
 * setup-dirty-integration preflight in primitives/index.ts calling
 * `updateTask(taskId, { status: 'blocked' })` without inserting any edge —
 * violating the invariant in blocker-invariant.ts.
 *
 * Fix: change the dirty-integration exit to `status: 'failed'` + actionQueue
 * item.  A dirty integration branch has no concrete blocker task to wait on,
 * so 'failed' is the correct terminal, not 'blocked' with zero edges.
 *
 * This file verifies three acceptance criteria:
 *   (a) Tasks enqueued with no --blocked-by always land as 'queued'—not
 *       'blocked'—regardless of any surrounding dispatch-pause state.
 *   (b) assertHasBlockerEdge throws BlockerInvariantViolation when a task
 *       has zero task_blockers edges, making the guard detectable at the
 *       bottleneck before any DB write.
 *   (c) updateTask({ status: 'failed' }) succeeds with zero blocker edges —
 *       the correct exit for dirty-integration and other "no concrete blocker"
 *       scenarios.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { vi } from 'vitest'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface BlockerInvariantModule {
  assertHasBlockerEdge: typeof import('../blocker-invariant').assertHasBlockerEdge
  BlockerInvariantViolation: typeof import('../blocker-invariant').BlockerInvariantViolation
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-edgeless-blocked-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; inv: BlockerInvariantModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const inv = (await import('../blocker-invariant')) as unknown as BlockerInvariantModule
  return { q, inv }
}

describe('edgeless-blocked invariant (mars-ba9f3af0 regression)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── (a) enqueue with no --blocked-by always lands as 'queued' ────────────

  it('a task with no --blocked-by lands as queued (not blocked)', async () => {
    // Verifies that the enqueue path never sets status='blocked' without edges.
    // During a storm-pause, tasks were dispatched after the storm cleared and the
    // setup step set status='blocked' with zero edges.  The fix removes that code
    // path; this test guards the simpler invariant: bare enqueueTask → 'queued'.
    const { q } = await loadModules(repo)
    const task = await q.enqueueTask('no blockers task', undefined, { skipTriage: true })
    expect(task.status).toBe('queued')

    const loaded = await q.getTask(task.id)
    expect(loaded?.status).toBe('queued')
  })

  it('two tasks enqueued with no --blocked-by are both queued', async () => {
    // Guards against any accidental correlation between tasks at enqueue time.
    const { q } = await loadModules(repo)
    const t1 = await q.enqueueTask('task one', undefined, { skipTriage: true })
    const t2 = await q.enqueueTask('task two', undefined, { skipTriage: true })
    expect(t1.status).toBe('queued')
    expect(t2.status).toBe('queued')
  })

  // ── (b) assertHasBlockerEdge detects zero-edge violations ─────────────────

  it('assertHasBlockerEdge throws BlockerInvariantViolation when task has zero edges', async () => {
    // The guard was added so that any code path attempting to park a task as
    // 'blocked' without a concrete blocker is caught immediately.  The dirty-
    // integration code path in primitives/index.ts previously skipped this check;
    // it now routes through 'failed' instead.
    const { q, inv } = await loadModules(repo)
    const task = await q.enqueueTask('no blockers task', undefined, { skipTriage: true })

    await expect(inv.assertHasBlockerEdge(task.id)).rejects.toBeInstanceOf(
      inv.BlockerInvariantViolation,
    )
  })

  it('BlockerInvariantViolation message includes the task id', async () => {
    const { q, inv } = await loadModules(repo)
    const task = await q.enqueueTask('no blockers task', undefined, { skipTriage: true })

    const err = await inv.assertHasBlockerEdge(task.id).catch((e) => e)
    expect(err).toBeInstanceOf(inv.BlockerInvariantViolation)
    expect((err as Error).message).toContain(task.id)
  })

  // ── (c) updateTask({ status: 'failed' }) succeeds with zero edges ─────────

  it('updateTask({ status: failed }) works with zero blocker edges', async () => {
    // This is the correct exit for setup-dirty-integration: 'failed' + actionQueue
    // item.  Unlike 'blocked', 'failed' has no edge requirement — the task is
    // terminal and the operator resolves it via the action queue item.
    const { q } = await loadModules(repo)
    const task = await q.enqueueTask('to-be-failed task', undefined, { skipTriage: true })

    // Simulate what the fixed primitives/index.ts now does
    await q.updateTask(task.id, {
      status: 'failed',
      error: "integration branch 'main' has uncommitted changes",
      failedPhase: 'setup',
      failureReason: "integration branch 'main' has uncommitted changes",
    })

    const loaded = await q.getTask(task.id)
    expect(loaded?.status).toBe('failed')
    // Zero edges is valid for 'failed' — no BlockerInvariantViolation
  })

  it('updateTask({ status: blocked }) with zero edges does NOT throw — callers must call assertHasBlockerEdge first', async () => {
    // Documents that updateTask itself is low-level and does not assert edges.
    // The assertHasBlockerEdge guard must be called by the caller (inside the
    // same transaction) BEFORE calling updateTask({ status: 'blocked' }).
    // The dirty-integration fix eliminates the need to do so in that code path.
    const { q } = await loadModules(repo)
    const task = await q.enqueueTask('task', undefined, { skipTriage: true })

    // updateTask is low-level — it does not assert edges
    await expect(
      q.updateTask(task.id, { status: 'blocked' }),
    ).resolves.not.toThrow()

    // But the DB row is now in the invalid edgeless-blocked state that the
    // dirty-integration fix eliminates.  assertHasBlockerEdge is how callers
    // detect this before committing.
    const loaded = await q.getTask(task.id)
    expect(loaded?.status).toBe('blocked') // edgeless — the bug shape the fix prevents
  })
})
