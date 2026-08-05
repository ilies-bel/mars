import { beforeEach, describe, expect, it } from 'vitest'
import { type DbClient } from '../../core/lib/db.js'
import { getTestDb } from '../../../test/db-fixture.js'
import { publishWithRetry, withWriteTx } from '../publisher.js'

describe('publishWithRetry: concurrent writers', () => {
  let client: DbClient

  beforeEach(async () => {
    client = await getTestDb()
  })

  it('two concurrent publishWithRetry calls both commit with distinct monotonic ids', async () => {
    // Launch two concurrent writers. Under PostgreSQL MVCC there is no
    // busy/lock contention to retry around; both transactions commit.
    await Promise.all([
      publishWithRetry(client, 'task.queued', { taskId: 'aaa' }),
      publishWithRetry(client, 'task.queued', { taskId: 'bbb' }),
    ])

    const result = await client.execute(
      'SELECT id, payload FROM events ORDER BY id',
    )
    expect(result.rows).toHaveLength(2)

    // IDs must be distinct and strictly increasing (identity sequence —
    // monotonic, possibly gappy).
    const id1 = Number(result.rows[0].id)
    const id2 = Number(result.rows[1].id)
    expect(id2).toBeGreaterThan(id1)

    // Both payloads must be present (order may vary due to concurrent commits).
    const taskIds = result.rows.map(
      r => (JSON.parse(r.payload as string) as { taskId: string }).taskId,
    )
    expect(taskIds).toContain('aaa')
    expect(taskIds).toContain('bbb')
  })

  it('rejects an invalid payload before any row is written', async () => {
    await expect(
      publishWithRetry(
        client,
        'task.queued',
        // Wrong shape: taskId must be a string.
        { taskId: 123 } as unknown as { taskId: string },
      ),
    ).rejects.toThrow()

    const result = await client.execute('SELECT COUNT(*) AS n FROM events')
    expect(Number(result.rows[0].n)).toBe(0)
  })
})

describe('withWriteTx', () => {
  let client: DbClient

  beforeEach(async () => {
    client = await getTestDb()
  })

  it('rolls the transaction back when fn throws — no partial writes remain', async () => {
    await expect(
      withWriteTx(client, async tx => {
        await tx.execute({
          sql: 'INSERT INTO events (type, payload) VALUES (?, ?)',
          args: ['task.queued', '{"taskId":"doomed"}'],
        })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const result = await client.execute('SELECT COUNT(*) AS n FROM events')
    expect(Number(result.rows[0].n)).toBe(0)
  })

  it('commits and returns the callback result on success', async () => {
    const out = await withWriteTx(client, async tx => {
      await tx.execute({
        sql: 'INSERT INTO events (type, payload) VALUES (?, ?)',
        args: ['task.queued', '{"taskId":"kept"}'],
      })
      return 'ok'
    })
    expect(out).toBe('ok')

    const result = await client.execute('SELECT COUNT(*) AS n FROM events')
    expect(Number(result.rows[0].n)).toBe(1)
  })
})
