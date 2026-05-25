import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { publishWithRetry } from '../publisher.js'

/**
 * Create a fresh file-backed libsql client with the events table schema.
 *
 * A temporary file is used rather than `:memory:` because the libsql
 * local backend creates a new in-process connection per transaction for
 * `:memory:` URLs, which causes each transaction to see an empty database
 * (the table created before the first transaction is invisible to the
 * second). A file-backed database shares state across all transactions on
 * the same client, which is the behaviour the concurrent-writer test needs.
 */
async function makeClient(dir: string): Promise<Client> {
  const client = createClient({ url: `file:${join(dir, 'events.db')}` })
  await client.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      type      TEXT    NOT NULL,
      payload   TEXT    NOT NULL DEFAULT '{}',
      created_at TEXT   NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  return client
}

describe('publishWithRetry: concurrent writers', () => {
  let tmpDir: string
  let client: Client

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-publisher-test-'))
    client = await makeClient(tmpDir)
  })

  afterEach(() => {
    client.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('two concurrent publishWithRetry calls both commit with distinct monotonic ids', async () => {
    // Launch two concurrent writers — no retry loop here.  The production
    // helper is the sole retry surface; the test just asserts the outcome.
    await Promise.all([
      publishWithRetry(client, 'task.queued', { taskId: 'aaa' }),
      publishWithRetry(client, 'task.queued', { taskId: 'bbb' }),
    ])

    const result = await client.execute(
      'SELECT id, payload FROM events ORDER BY id',
    )
    expect(result.rows).toHaveLength(2)

    // IDs must be distinct and strictly increasing (monotonic autoincrement).
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
})
