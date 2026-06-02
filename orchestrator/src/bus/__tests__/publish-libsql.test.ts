import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueMod {
  initQueue: typeof import('../../core/queue').initQueue
  getClient: typeof import('../../core/queue').getClient
}

interface PublishMod {
  publish: typeof import('../publisher').publish
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-bus-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (
  repo: string,
): Promise<{ q: QueueMod; p: PublishMod }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../core/queue')) as unknown as QueueMod
  await q.initQueue()
  const p = (await import('../publisher')) as unknown as PublishMod
  return { q, p }
}

describe('publish-libsql: atomic event insertion', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('commits an event row atomically with a state write', async () => {
    const { q, p } = await loadMods(repo)
    const client = q.getClient()

    // Enqueue a real task row so we have something to write in the same tx.
    const now = new Date().toISOString()
    const tx = await client.transaction('write')
    try {
      // Publish event inside transaction.
      await p.publish(tx, 'task.queued', { taskId: 'abc' })
      // Simulate an accompanying state write inside the same tx.
      await tx.execute({
        sql: `INSERT INTO tasks
                (id, prompt, status, origin_id, retry_count, created_at, updated_at)
              VALUES ('abc', 'test task', 'queued', 'abc', 0, ?, ?)`,
        args: [now, now],
      })
      await tx.commit()
    } catch (err) {
      tx.close()
      throw err
    }

    // Both rows must be visible now.
    const evtResult = await client.execute(
      'SELECT id, type, payload FROM events ORDER BY id',
    )
    expect(evtResult.rows).toHaveLength(1)
    const row = evtResult.rows[0] as unknown as {
      id: number
      type: string
      payload: string
    }
    expect(row.type).toBe('task.queued')
    expect(JSON.parse(row.payload)).toEqual({ taskId: 'abc' })

    const taskResult = await client.execute(
      `SELECT id FROM tasks WHERE id = 'abc'`,
    )
    expect(taskResult.rows).toHaveLength(1)
  })

  it('rolls back both event and state write on transaction rollback', async () => {
    const { q, p } = await loadMods(repo)
    const client = q.getClient()

    const now = new Date().toISOString()
    const tx = await client.transaction('write')
    // Publish event and a state row — then roll back.
    await p.publish(tx, 'task.queued', { taskId: 'xyz' })
    await tx.execute({
      sql: `INSERT INTO tasks
              (id, prompt, status, origin_id, retry_count, created_at, updated_at)
            VALUES ('xyz', 'rollback task', 'queued', 'xyz', 0, ?, ?)`,
      args: [now, now],
    })
    await tx.rollback()

    // Events table must be empty — the insert was rolled back.
    const evtResult = await client.execute(
      'SELECT COUNT(*) AS n FROM events',
    )
    const n = Number(
      (evtResult.rows[0] as unknown as { n: number | bigint }).n,
    )
    expect(n).toBe(0)

    // Task row must also be absent.
    const taskResult = await client.execute(
      `SELECT id FROM tasks WHERE id = 'xyz'`,
    )
    expect(taskResult.rows).toHaveLength(0)
  })
})
