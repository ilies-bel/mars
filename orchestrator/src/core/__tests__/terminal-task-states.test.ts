import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  enqueueTask: typeof import('../queue').enqueueTask
  getTask: typeof import('../queue').getTask
  updateTask: typeof import('../queue').updateTask
  reopenTerminalTask: typeof import('../queue').reopenTerminalTask
  resolveQueueClient: typeof import('../queue').resolveQueueClient
  IllegalTransitionError: typeof import('../queue').IllegalTransitionError
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-terminal-task-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string): Promise<QueueModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = await import('../queue')
  await queue.migrateQueueSchema()
  return queue as unknown as QueueModule
}

describe('terminal task states', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })
  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('rejects ordinary writes out of a terminal state before they reach the database', async () => {
    const q = await loadQueue(repo)
    const task = await q.enqueueTask('terminal task', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'failed' })

    await expect(q.updateTask(task.id, { status: 'queued' })).rejects.toBeInstanceOf(
      q.IllegalTransitionError,
    )
    expect((await q.getTask(task.id))?.status).toBe('failed')
  })

  it('rejects a raw database write out of a terminal state', async () => {
    const q = await loadQueue(repo)
    const task = await q.enqueueTask('terminal task', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'done' })

    await expect(q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [task.id],
    })).rejects.toThrow(/terminal task/i)
  })

  it('records an audited restart before reopening a terminal task', async () => {
    const q = await loadQueue(repo)
    const task = await q.enqueueTask('restartable task', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'failed' })

    await q.reopenTerminalTask(task.id, 'mars restart')

    expect((await q.getTask(task.id))?.status).toBe('queued')
    const audit = await q.resolveQueueClient().execute({
      sql: `SELECT reason, reopened_by, consumed_at FROM task_terminal_reopens WHERE task_id = ?`,
      args: [task.id],
    })
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]).toMatchObject({ reason: 'mars restart', reopened_by: 'operator' })
  })
})
