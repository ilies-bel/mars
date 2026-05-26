/**
 * Outbox atomicity tests for updateTask.
 *
 * Verifies that every status-changing updateTask call writes the state row
 * and the outbox event row in the SAME transaction — so a crash between the
 * two leaves neither orphaned state (no matching event) nor an orphaned
 * event (no matching state).
 *
 * Acceptance criteria:
 *   (a) state row AND event land in the same commit (both present after a
 *       successful updateTask call)
 *   (b) when the event INSERT fails, the state write is rolled back and the
 *       error propagates (verified by dropping the events table)
 *   (c) unchanged-status write emits no event and throws no error
 *   (d) the common non-session-id path (most status transitions) emits
 *       atomically — event is present and state is updated in one commit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueMod {
  initQueue: typeof import('../queue').initQueue
  getClient: typeof import('../queue').getClient
  enqueueTask: typeof import('../queue').enqueueTask
  updateTask: typeof import('../queue').updateTask
  getTask: typeof import('../queue').getTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-atomic-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string): Promise<QueueMod> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../queue')
  await mod.initQueue()
  return mod as unknown as QueueMod
}

const getEventsOfType = async (
  q: QueueMod,
  type: string,
): Promise<Array<{ type: string; payload: Record<string, unknown> }>> => {
  const result = await q.getClient().execute({
    sql: `SELECT type, payload FROM events WHERE type = ? ORDER BY id`,
    args: [type],
  })
  return (result.rows as unknown as Array<{ type: string; payload: string }>).map(
    (r) => ({
      type: r.type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }),
  )
}

describe('updateTask outbox atomicity', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── (a) State row and event land in the same commit ──────────────────────
  //
  // After a successful updateTask, the task's new status AND the matching
  // event row must both be present. This is the basic "writes are not lost"
  // check; the rollback test (b) is the true atomicity proof.

  it('(a) state row and event are both present after a successful status transition', async () => {
    const q = await loadQueue(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
    // task is now 'queued'; transition to 'done'
    await q.updateTask(task.id, { status: 'done' })

    const fetched = await q.getTask(task.id)
    expect(fetched?.status).toBe('done')

    const events = await getEventsOfType(q, 'task.completed')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ taskId: task.id })
  })

  // ── (b) Event INSERT failure rolls back the state write ──────────────────
  //
  // Drop the events table to force the event INSERT inside the transaction to
  // fail. The transaction must roll back entirely — the task's status must
  // remain unchanged and updateTask must propagate the error.

  it('(b) state write is rolled back and error propagates when event INSERT fails', async () => {
    const q = await loadQueue(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
    // status is 'queued' — remember it for comparison after the failed update

    // Drop the events table so the INSERT inside the transaction will throw
    await q.getClient().execute('DROP TABLE events')

    // updateTask must now throw (not swallow the error)
    await expect(
      q.updateTask(task.id, { status: 'done' }),
    ).rejects.toThrow()

    // State row must still be 'queued' — the UPDATE was rolled back
    const result = await q.getClient().execute({
      sql: 'SELECT status FROM tasks WHERE id = ?',
      args: [task.id],
    })
    const status = (result.rows[0] as unknown as { status: string }).status
    expect(status).toBe('queued')
  })

  // ── (c) Unchanged-status write emits no event and throws no error ────────
  //
  // Writing the same status that the task already has must be a no-op:
  // no event row is inserted and no error is thrown.

  it('(c) no event emitted and no error thrown when status is unchanged', async () => {
    const q = await loadQueue(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
    // task is already 'queued' — writing the same status twice is a no-op
    await expect(q.updateTask(task.id, { status: 'queued' })).resolves.toBeUndefined()
    await expect(q.updateTask(task.id, { status: 'queued' })).resolves.toBeUndefined()

    // Zero events of any kind must have been written
    const result = await q.getClient().execute('SELECT COUNT(*) AS n FROM events')
    const n = Number((result.rows[0] as unknown as { n: number | bigint }).n)
    expect(n).toBe(0)
  })

  // ── (d) Common (non-session-id) path emits atomically ───────────────────
  //
  // The non-session-id branch is the one taken by almost every real status
  // transition (it does NOT set claudeSessionId).  Confirm that calling
  // updateTask without a claudeSessionId field:
  //   1. emits exactly one schema-valid event,
  //   2. updates the task status,
  //   3. rolls back when the event write fails (same rollback guarantee as (b)).

  it('(d) non-session-id path emits exactly one event per real status transition', async () => {
    const q = await loadQueue(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    // Explicitly omit claudeSessionId — this is the common non-session-id path
    await q.updateTask(task.id, { status: 'failed', error: 'verify failed' })

    const fetched = await q.getTask(task.id)
    expect(fetched?.status).toBe('failed')

    const events = await getEventsOfType(q, 'task.failed')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({
      taskId: task.id,
      error: 'verify failed',
    })
  })

  it('(d) non-session-id path rolls back state when event INSERT fails', async () => {
    const q = await loadQueue(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    // Drop events table to force the event INSERT to fail
    await q.getClient().execute('DROP TABLE events')

    // updateTask without claudeSessionId (the common path) — must throw
    await expect(
      q.updateTask(task.id, { status: 'failed', error: 'oops' }),
    ).rejects.toThrow()

    // State must not have been written
    const result = await q.getClient().execute({
      sql: 'SELECT status FROM tasks WHERE id = ?',
      args: [task.id],
    })
    const status = (result.rows[0] as unknown as { status: string }).status
    expect(status).toBe('queued')
  })
})
