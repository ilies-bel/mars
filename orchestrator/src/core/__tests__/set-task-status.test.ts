/**
 * Acceptance tests for Arc.setTaskStatus — the single-writer chokepoint that
 * wraps every `UPDATE tasks SET status` and its matching outbox event in one
 * write transaction. Relocated into the Arc aggregate (ADR-0052 sole-writer);
 * the historic `queue.setTaskStatus` export is gone.
 *
 * Acceptance criteria (from PRD 12fdef39 slice 1, preserved across the move):
 *   - calling Arc.setTaskStatus(id, 'done') leaves the row in 'done' and writes
 *     exactly one 'task.completed' event to the events table
 *   - the event and the status write land in the same commit (no orphan state
 *     without event, no orphan event without state)
 *
 * Also covers: failure field cleanup on done transition (2026-07-06).
 *   A task that carried failure_reason / failure_signature from a prior failed
 *   attempt must have those fields NULL-ed out when it reaches 'done', whether
 *   the done transition goes through Arc.setTaskStatus (the propagateRecoveryDone
 *   path) or directly through updateTask.
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
  updateTask: typeof import('../queue').updateTask
  getTask: typeof import('../queue').getTask
}

interface ArcMod {
  Arc: typeof import('../arc').Arc
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-set-task-status-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (repo: string): Promise<QueueMod & ArcMod> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = await import('../queue')
  await queue.migrateQueueSchema()
  const arc = await import('../arc')
  return { ...(queue as unknown as QueueMod), Arc: arc.Arc }
}

/** Write failure columns directly — simulates what a failed task carry. */
const stampFailure = async (
  q: QueueMod,
  id: string,
  reason: string,
  signature: string,
): Promise<void> => {
  await q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET status = 'failed', failure_reason = ?, failure_signature = ?, failure_reason_code = 'test:failure' WHERE id = ?`,
    args: [reason, signature, id],
  })
}

describe('Arc.setTaskStatus', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('sets status to done and writes exactly one task.completed event', async () => {
    const q = await loadMods(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    await q.Arc.setTaskStatus(task.id, 'done')

    // Row is in done
    const fetched = await q.getTask(task.id)
    expect(fetched?.status).toBe('done')

    // Exactly one task.completed event — no duplicates, no task.terminal from setTaskStatus
    const result = await q.resolveQueueClient().execute({
      sql: `SELECT type, payload FROM events WHERE type = 'task.completed' ORDER BY id`,
      args: [],
    })
    expect(result.rows).toHaveLength(1)
    const payload = JSON.parse(
      (result.rows[0] as unknown as { type: string; payload: string }).payload,
    )
    expect(payload).toMatchObject({ taskId: task.id })
  })

  it('emits task.failed for the failed status with the provided error', async () => {
    const q = await loadMods(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    await q.Arc.setTaskStatus(task.id, 'failed', { error: 'verify exploded' })

    const fetched = await q.getTask(task.id)
    expect(fetched?.status).toBe('failed')

    const result = await q.resolveQueueClient().execute({
      sql: `SELECT type, payload FROM events WHERE type = 'task.failed' ORDER BY id`,
      args: [],
    })
    expect(result.rows).toHaveLength(1)
    const payload = JSON.parse(
      (result.rows[0] as unknown as { type: string; payload: string }).payload,
    )
    expect(payload).toMatchObject({ taskId: task.id, error: 'verify exploded' })
  })

  it('rolls back the status write when the event INSERT fails', async () => {
    const q = await loadMods(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    // Drop the events table to force the INSERT inside the transaction to fail
    await q.resolveQueueClient().execute('DROP TABLE events')

    // Arc.setTaskStatus must propagate the error
    await expect(q.Arc.setTaskStatus(task.id, 'done')).rejects.toThrow()

    // Row must still be queued — the UPDATE was rolled back atomically
    const result = await q.resolveQueueClient().execute({
      sql: 'SELECT status FROM tasks WHERE id = ?',
      args: [task.id],
    })
    const status = (result.rows[0] as unknown as { status: string }).status
    expect(status).toBe('queued')
  })

  it('writes no event for statuses without a mapping (e.g. blocked)', async () => {
    const q = await loadMods(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    await q.Arc.setTaskStatus(task.id, 'blocked')

    const fetched = await q.getTask(task.id)
    expect(fetched?.status).toBe('blocked')

    // No events should have been written for this status-only write
    const result = await q.resolveQueueClient().execute(`SELECT COUNT(*) AS n FROM events`)
    const n = Number((result.rows[0] as unknown as { n: number | bigint }).n)
    expect(n).toBe(0)
  })

  it('routes the row write + event through store.batch when a store is provided', async () => {
    const q = await loadMods(repo)
    const { getDefaultTaskStore } = await import('../store/task-store')
    const store = await getDefaultTaskStore()
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    await q.Arc.setTaskStatus(task.id, 'done', { result: { via: 'recovery' } }, store)

    const fetched = await q.getTask(task.id)
    expect(fetched?.status).toBe('done')

    const result = await q.resolveQueueClient().execute({
      sql: `SELECT type, payload FROM events WHERE type = 'task.completed' ORDER BY id`,
      args: [],
    })
    expect(result.rows).toHaveLength(1)
    const payload = JSON.parse(
      (result.rows[0] as unknown as { type: string; payload: string }).payload,
    )
    expect(payload).toMatchObject({ taskId: task.id, result: { via: 'recovery' } })
  })
})

describe('failure field cleanup on done transition', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('Arc.setTaskStatus clears failure_reason / failure_signature when completing a previously failed task', async () => {
    // Scenario: a task failed (e.g. setup:origin-worktree-missing), the origin is
    // later recovered, and propagateRecoveryDone calls Arc.setTaskStatus(id, 'done').
    // The done row must NOT retain the stale failure fields.
    const q = await loadMods(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    // Stamp failure columns directly — mirrors what a failed run leaves behind.
    await stampFailure(q, task.id, 'setup:origin-worktree-missing', 'sig-abc')

    // Simulate propagateRecoveryDone completing the origin.
    await q.Arc.setTaskStatus(task.id, 'done')

    const row = await q.resolveQueueClient().execute({
      sql: `SELECT status, failure_reason, failure_signature, failure_reason_code FROM tasks WHERE id = ?`,
      args: [task.id],
    })
    const r = row.rows[0] as unknown as {
      status: string
      failure_reason: string | null
      failure_signature: string | null
      failure_reason_code: string | null
    }
    expect(r.status).toBe('done')
    expect(r.failure_reason).toBeNull()
    expect(r.failure_signature).toBeNull()
    expect(r.failure_reason_code).toBeNull()
  })

  it('Arc.setTaskStatus with store clears failure fields on done transition', async () => {
    const q = await loadMods(repo)
    const { getDefaultTaskStore } = await import('../store/task-store')
    const store = await getDefaultTaskStore()
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    await stampFailure(q, task.id, 'verify:typecheck', 'sig-xyz')

    await q.Arc.setTaskStatus(task.id, 'done', { result: { via: 'recovery' } }, store)

    const row = await q.resolveQueueClient().execute({
      sql: `SELECT status, failure_reason, failure_signature, failure_reason_code FROM tasks WHERE id = ?`,
      args: [task.id],
    })
    const r = row.rows[0] as unknown as {
      status: string
      failure_reason: string | null
      failure_signature: string | null
      failure_reason_code: string | null
    }
    expect(r.status).toBe('done')
    expect(r.failure_reason).toBeNull()
    expect(r.failure_signature).toBeNull()
    expect(r.failure_reason_code).toBeNull()
  })

  it('updateTask clears failure fields when transitioning a failed task to done', async () => {
    const q = await loadMods(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    await stampFailure(q, task.id, 'code:exit-1', 'sig-code')

    // Direct updateTask path — used when the implement pipeline marks done.
    await q.updateTask(task.id, { status: 'done' })

    const row = await q.resolveQueueClient().execute({
      sql: `SELECT status, failure_reason, failure_signature, failure_reason_code FROM tasks WHERE id = ?`,
      args: [task.id],
    })
    const r = row.rows[0] as unknown as {
      status: string
      failure_reason: string | null
      failure_signature: string | null
      failure_reason_code: string | null
    }
    expect(r.status).toBe('done')
    expect(r.failure_reason).toBeNull()
    expect(r.failure_signature).toBeNull()
    expect(r.failure_reason_code).toBeNull()
  })
})
