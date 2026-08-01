import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetDbRegistryForTests, openDb, type DbClient } from '../../lib/db.js'
import { ensureSchema } from '../../lib/pg-schema.js'
import {
  advanceMainMemoryWindow,
  markMainMemoryWindowUsed,
  readMainMemoryWindow,
  selectMemoryCut,
} from '../chat-memory-window.js'

let counter = 0
const freshKey = (): string => `chat-memory-window-${process.pid}-${(counter += 1)}`

const memory = { retentionMs: 1_000, minimumReusablePrefixTokens: 1, contextWindowTokens: 16 }

const insertSubject = async (
  client: DbClient,
  id: string,
  closedAt: number | null,
  content: string,
  contextScope: 'main' | 'subject' = 'main',
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO chat_threads (id, title, status, closed_at, created_at, updated_at)
          VALUES (?, ?, 'idle', ?, 0, 0)`,
    args: [id, id, closedAt],
  })
  await client.execute({
    sql: `INSERT INTO chat_messages (id, thread_id, role, content, created_at, context_scope, kind)
          VALUES (?, ?, 'assistant', ?, 0, ?, 'situation')`,
    args: [`${id}-message`, id, content, contextScope],
  })
}

describe('Main-session memory window', () => {
  let client: DbClient

  beforeEach(async () => {
    process.env.MARS_DB_BACKEND = 'pglite'
    client = openDb(freshKey())
    await ensureSchema(client)
  })

  afterEach(async () => {
    await client.close()
    await __resetDbRegistryForTests()
  })

  it('keeps a warm prefix within the context window and creates the durable Main record', async () => {
    await insertSubject(client, 'finished', 10, 'x'.repeat(60))

    expect(await selectMemoryCut(client, memory, 100)).toBeNull()
    expect(await readMainMemoryWindow(client)).toEqual({
      startsAfterSeq: 0,
      lastUsedAt: null,
      cutAt: null,
      reason: null,
    })
  })

  it('drops only the oldest finished Subjects needed for an over-capacity prefix without deleting history', async () => {
    await insertSubject(client, 'first', 10, 'x'.repeat(32))
    await insertSubject(client, 'second', 20, 'y'.repeat(32))
    await insertSubject(client, 'third', 30, 'z'.repeat(32))

    const cut = await selectMemoryCut(client, memory, 100)
    expect(cut).toEqual({ startsAfterSeq: 1, reason: 'capacity' })
    await advanceMainMemoryWindow(client, cut!, 100)

    const window = await readMainMemoryWindow(client)
    expect(window).toMatchObject({ startsAfterSeq: 1, cutAt: 100, reason: 'capacity' })
    expect((await client.execute('SELECT id FROM chat_messages ORDER BY seq')).rows).toHaveLength(3)
  })

  it('cuts one oldest finished Subject synchronously after provider retention lapses', async () => {
    await insertSubject(client, 'first', 10, 'x'.repeat(8))
    await insertSubject(client, 'second', 20, 'y'.repeat(8))
    await markMainMemoryWindowUsed(client, 0)

    const cut = await selectMemoryCut(client, memory, 1_000)
    expect(cut).toMatchObject({ reason: 'retention-lapse', startsAfterSeq: 1 })
    await advanceMainMemoryWindow(client, cut!, 1_000)

    expect(await readMainMemoryWindow(client)).toMatchObject({
      startsAfterSeq: 1,
      lastUsedAt: 0,
      cutAt: 1_000,
      reason: 'retention-lapse',
    })
  })

  it('never crosses an active Subject when selecting a cut', async () => {
    await insertSubject(client, 'active', null, 'a'.repeat(8))
    await insertSubject(client, 'finished', 10, 'b'.repeat(80))

    expect(await selectMemoryCut(client, memory, 100)).toBeNull()
  })
})
