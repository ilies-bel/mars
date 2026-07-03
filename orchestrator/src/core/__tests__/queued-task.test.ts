/**
 * Acceptance tests for the "queued" task lifecycle.
 *
 * Verifies the observable behaviour of tasks that reach the `'queued'`
 * status — the only dispatch-eligible status — through the public
 * `enqueueTask` / `promoteDraftToQueued` / `isDispatchableStatus` surface.
 *
 * Acceptance criteria:
 *   1. A task created with `skipTriage: true` lands immediately in `'queued'`
 *   2. A task created without `skipTriage` starts as `'draft'` (not dispatchable)
 *   3. `isDispatchableStatus` returns `true` only for `'queued'`
 *   4. `promoteDraftToQueued` advances a `'draft'` task to `'queued'` and
 *      emits exactly one `task.queued` event in the same transaction
 *   5. `promoteDraftToQueued` is a no-op (returns null, emits no event) when
 *      the task has active confirmed or pending-review blockers
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../queue').resolveQueueClient
  enqueueTask: typeof import('../queue').enqueueTask
  getTask: typeof import('../queue').getTask
  isDispatchableStatus: typeof import('../queue').isDispatchableStatus
  promoteDraftToQueued: typeof import('../queue').promoteDraftToQueued
  addBlockers: typeof import('../queue').addBlockers
  addPendingReviewBlockers: typeof import('../queue').addPendingReviewBlockers
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-queued-task-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (repo: string): Promise<QueueMod> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../queue')
  await mod.migrateQueueSchema()
  return mod as unknown as QueueMod
}

const getEventsOfType = async (
  q: QueueMod,
  type: string,
): Promise<Array<{ taskId: string }>> => {
  const result = await q.resolveQueueClient().execute({
    sql: `SELECT payload FROM events WHERE type = ? ORDER BY id`,
    args: [type],
  })
  return (result.rows as unknown as Array<{ payload: string }>).map((r) =>
    JSON.parse(r.payload) as { taskId: string },
  )
}

describe('queued task', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── 1. skipTriage: true → immediately queued ─────────────────────────────
  //
  // The common fast path: a CLI enqueue without a triage phase. The task must
  // land in 'queued' and be dispatchable without any additional promote call.

  it('task created with skipTriage:true is immediately in queued status', async () => {
    const q = await loadMods(repo)
    const task = await q.enqueueTask('do the work', undefined, { skipTriage: true })

    expect(task.status).toBe('queued')

    // Confirmed through a re-fetch so the test is not just checking the
    // in-memory return value — the DB row must also reflect 'queued'.
    const fetched = await q.getTask(task.id)
    expect(fetched?.status).toBe('queued')
  })

  // ── 2. default path → draft (not dispatchable) ───────────────────────────
  //
  // Without skipTriage the task enters the triage lane: draft → triaging →
  // queued.  The task must NOT be dispatchable at creation.

  it('task created without skipTriage starts as draft and is not dispatchable', async () => {
    const q = await loadMods(repo)
    const task = await q.enqueueTask('plan first')

    expect(task.status).toBe('draft')
    expect(q.isDispatchableStatus(task.status)).toBe(false)
  })

  // ── 3. isDispatchableStatus gate ─────────────────────────────────────────
  //
  // Every non-queued status must be non-dispatchable; only 'queued' passes.

  it('isDispatchableStatus returns true only for queued', async () => {
    const q = await loadMods(repo)
    const NON_DISPATCHABLE = [
      'draft',
      'triaging',
      'blocked',
      'running',
      'verifying',
      'awaiting-validation',
      'awaiting-human',
      'merging',
      'vega-reconciling',
      'done',
      'failed',
      'dropped',
      'under_investigation',
    ] as const

    for (const s of NON_DISPATCHABLE) {
      expect(q.isDispatchableStatus(s), `${s} must not be dispatchable`).toBe(false)
    }
    expect(q.isDispatchableStatus('queued')).toBe(true)
  })

  // ── 4. promoteDraftToQueued advances draft → queued + emits task.queued ──
  //
  // The promotion must be atomic: the status row flips AND a task.queued event
  // is written in the same transaction.

  it('promoteDraftToQueued advances a draft task to queued and emits task.queued event', async () => {
    const q = await loadMods(repo)
    const task = await q.enqueueTask('needs triage first')
    expect(task.status).toBe('draft')

    const promoted = await q.promoteDraftToQueued(task.id)
    expect(promoted).not.toBeNull()
    expect(promoted?.status).toBe('queued')
    expect(promoted?.id).toBe(task.id)

    const fetched = await q.getTask(task.id)
    expect(fetched?.status).toBe('queued')
    expect(q.isDispatchableStatus(fetched!.status)).toBe(true)

    const events = await getEventsOfType(q, 'task.queued')
    expect(events).toHaveLength(1)
    expect(events[0].taskId).toBe(task.id)
  })

  // ── 5a. confirmed blockers gate the promote ───────────────────────────────
  //
  // A task with a confirmed (incomplete) blocker must NOT flip to 'queued';
  // promoteDraftToQueued must return null and emit no event.

  it('promoteDraftToQueued returns null when a confirmed blocker exists', async () => {
    const q = await loadMods(repo)

    // Blocker task: must be in a non-done status to count as incomplete
    const blocker = await q.enqueueTask('blocking task', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('blocked task')
    expect(dependent.status).toBe('draft')

    await q.addBlockers(dependent.id, [blocker.id])

    // Promote must be gated — returns null, status stays draft
    const result = await q.promoteDraftToQueued(dependent.id)
    expect(result).toBeNull()

    const fetched = await q.getTask(dependent.id)
    expect(fetched?.status).toBe('draft')

    // No task.queued event must have been emitted
    const events = await getEventsOfType(q, 'task.queued')
    expect(events).toHaveLength(0)
  })

  // ── 5b. pending-review blockers gate the promote ──────────────────────────
  //
  // Linker candidates in 'pending-review' state carry the same gating
  // semantics as 'confirmed' blockers — promote must also be a no-op.

  it('promoteDraftToQueued returns null when a pending-review blocker exists', async () => {
    const q = await loadMods(repo)

    const blocker = await q.enqueueTask('pending blocker', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('gated task')

    await q.addPendingReviewBlockers(dependent.id, [blocker.id])

    const result = await q.promoteDraftToQueued(dependent.id)
    expect(result).toBeNull()

    const fetched = await q.getTask(dependent.id)
    expect(fetched?.status).toBe('draft')

    const events = await getEventsOfType(q, 'task.queued')
    expect(events).toHaveLength(0)
  })
})
