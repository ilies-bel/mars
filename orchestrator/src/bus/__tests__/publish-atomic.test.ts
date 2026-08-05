import { beforeEach, describe, expect, it } from 'vitest'
import { withTransaction, type DbClient } from '../../core/lib/db.js'
import { getTestDb } from '../../../test/db-fixture.js'
import { publish } from '../publisher.js'

describe('publish: atomic event insertion', () => {
  let client: DbClient

  beforeEach(async () => {
    client = await getTestDb()
  })

  it('commits an event row atomically with a state write', async () => {
    const now = new Date().toISOString()
    await withTransaction(client, async tx => {
      // Publish event inside the transaction.
      await publish(tx, 'task.queued', { taskId: 'abc' })
      // Simulate an accompanying state write inside the same tx.
      await tx.execute({
        sql: `INSERT INTO tasks
                (id, prompt, status, origin_id, retry_count, created_at, updated_at)
              VALUES ('abc', 'test task', 'queued', 'abc', 0, ?, ?)`,
        args: [now, now],
      })
    })

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
    const now = new Date().toISOString()
    // Publish event and a state row — then force a rollback by throwing.
    await expect(
      withTransaction(client, async tx => {
        await publish(tx, 'task.queued', { taskId: 'xyz' })
        await tx.execute({
          sql: `INSERT INTO tasks
                  (id, prompt, status, origin_id, retry_count, created_at, updated_at)
                VALUES ('xyz', 'rollback task', 'queued', 'xyz', 0, ?, ?)`,
          args: [now, now],
        })
        throw new Error('force rollback')
      }),
    ).rejects.toThrow('force rollback')

    // Events table must be empty — the insert was rolled back.
    const evtResult = await client.execute('SELECT COUNT(*) AS n FROM events')
    expect(Number((evtResult.rows[0] as unknown as { n: number }).n)).toBe(0)

    // Task row must also be absent.
    const taskResult = await client.execute(
      `SELECT id FROM tasks WHERE id = 'xyz'`,
    )
    expect(taskResult.rows).toHaveLength(0)
  })
})
