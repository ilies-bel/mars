import { beforeAll, describe, expect, it } from 'vitest'
import { getTestDb } from './db-fixture.js'

beforeAll(() => {
  process.env.MARS_DB_BACKEND = 'pglite'
})

describe('getTestDb', () => {
  it('gives a later test setup an empty database with its main chat thread', async () => {
    const first = await getTestDb()
    await first.execute({
      sql: `INSERT INTO chat_threads (id, title, created_at, updated_at)
            VALUES ('leftover', 'Must not leak', 1, 1)`,
    })

    const next = await getTestDb()

    expect(next).toBe(first)
    expect((await next.execute('SELECT id FROM chat_threads ORDER BY id')).rows)
      .toEqual([{ id: 'main' }])
  })
})
