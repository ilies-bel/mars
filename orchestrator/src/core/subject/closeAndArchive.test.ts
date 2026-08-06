/**
 * closeAndArchive — behaviour tests.
 *
 * Covered acceptance criteria:
 *   1. A single closeAndArchive call (inside withTransaction) sets closed_at,
 *      inserts one archive_entry with source_kind='subject', and inserts one
 *      chat_message with kind='context_line' in the main thread — all three
 *      confirmed on the happy path.
 *   2. Forcing a transaction rollback after closeAndArchive leaves zero of each
 *      write persisted (all-or-nothing atomicity proof).
 *
 * System boundary: real PGlite DB (openDb) with the full canonical schema.
 * No mocks — all writes exercise the actual SQL paths.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDb, withTransaction, type DbClient } from '../lib/db.js'
import { closeAndArchive } from './closeAndArchive.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Insert a minimal Subject row and return its id. Defaults to a non-null title
 * so the rendered context line is deterministic.
 */
async function insertSubject(client: DbClient, title = 'Test Subject'): Promise<string> {
  const id = randomUUID()
  const now = Date.now()
  await client.execute({
    sql: `INSERT INTO chat_threads
            (id, title, status, created_at, updated_at)
          VALUES (?, ?, 'idle', ?, ?)`,
    args: [id, title, now, now],
  })
  return id
}

/** Return the closed_at value for a Subject, or null if not found / not closed. */
async function getClosedAt(client: DbClient, subjectId: string): Promise<number | null> {
  const r = await client.execute({
    sql: `SELECT closed_at FROM chat_threads WHERE id = ?`,
    args: [subjectId],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as Record<string, unknown>
  return row.closed_at == null ? null : Number(row.closed_at)
}

/** Count rows in archive_entries for a given source_id. */
async function archiveCountForSource(client: DbClient, sourceId: string): Promise<number> {
  const r = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM archive_entries WHERE source_id = ?`,
    args: [sourceId],
  })
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

/** Count context_line messages in the main thread. */
async function contextLineCount(client: DbClient): Promise<number> {
  const r = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM chat_messages WHERE kind = 'context_line' AND thread_id = 'main'`,
  })
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

// ── Suite setup ───────────────────────────────────────────────────────────────

describe('closeAndArchive', () => {
  let client: DbClient

  beforeEach(async () => {
    // Fresh PGlite instance per test — schema (including the main-thread sentinel)
    // is bootstrapped on the first execute call.
    client = openDb(`pglite://close-and-archive-test-${randomUUID()}`)
    // Trigger schema bootstrap before each test.
    await client.execute('SELECT 1')
  })

  afterEach(async () => {
    await client.close()
  })

  // ── Happy path ────────────────────────────────────────────────────────────────

  it('sets closed_at, inserts one archive_entry and one context_line', async () => {
    const subjectId = await insertSubject(client)

    await withTransaction(client, (tx) => closeAndArchive(subjectId, tx))

    // 1. lifecycle_status='closed': closed_at is now set
    expect(await getClosedAt(client, subjectId)).not.toBeNull()

    // 2. archive_entry with source_kind='subject'
    const archiveRows = await client.execute({
      sql: `SELECT source_kind, source_id, kind FROM archive_entries WHERE source_id = ?`,
      args: [subjectId],
    })
    expect(archiveRows.rows).toHaveLength(1)
    const archiveRow = archiveRows.rows[0] as Record<string, unknown>
    expect(archiveRow.source_kind).toBe('subject')
    expect(archiveRow.source_id).toBe(subjectId)
    expect(archiveRow.kind).toBe('closed')

    // 3. context_line in main thread
    expect(await contextLineCount(client)).toBe(1)
    const msgRows = await client.execute({
      sql: `SELECT kind, thread_id, backing_entity_id FROM chat_messages WHERE kind = 'context_line'`,
    })
    expect(msgRows.rows).toHaveLength(1)
    const msgRow = msgRows.rows[0] as Record<string, unknown>
    expect(msgRow.thread_id).toBe('main')
    expect(msgRow.backing_entity_id).toBe(subjectId)
  })

  // ── Rollback: forced failure → 0 of each write ────────────────────────────────

  it('rolls back all three writes when the transaction is aborted', async () => {
    const subjectId = await insertSubject(client)

    // All three writes happen inside a transaction that we then abort.
    let caught: unknown
    try {
      await withTransaction(client, async (tx) => {
        await closeAndArchive(subjectId, tx)
        throw new Error('forced rollback')
      })
    } catch (e) {
      caught = e
    }

    expect((caught as Error).message).toBe('forced rollback')

    // None of the three writes persisted.
    expect(await getClosedAt(client, subjectId)).toBeNull()
    expect(await archiveCountForSource(client, subjectId)).toBe(0)
    expect(await contextLineCount(client)).toBe(0)
  })
})
