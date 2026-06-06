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
