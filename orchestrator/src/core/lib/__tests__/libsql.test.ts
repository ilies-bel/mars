import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibsql, withTransaction } from '../libsql'
import type { Client } from '@libsql/client'

describe('openLibsql', () => {
  let tmpDir: string
  let client: Client

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-libsql-test-'))
  })

  afterEach(() => {
    client.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('enables foreign_keys pragma on the opened connection', async () => {
    client = openLibsql({ url: `file:${join(tmpDir, 'test.db')}` })
    // @libsql/client serialises all execute() calls on a file: URL's single
    // connection — querying the pragma here is guaranteed to run AFTER the
    // foreign_keys=ON pragma was applied.
    const result = await client.execute('PRAGMA foreign_keys')
    expect(result.rows[0]['foreign_keys']).toBe(1)
  })

  it('enables WAL journal mode', async () => {
    client = openLibsql({ url: `file:${join(tmpDir, 'test.db')}` })
    // The journal_mode=WAL pragma is queued synchronously before openLibsql
    // returns, so this check runs after it has been applied.
    const result = await client.execute('PRAGMA journal_mode')
    expect(result.rows[0]['journal_mode']).toBe('wal')
  })

  it('applies a 5000 ms busy timeout', async () => {
    client = openLibsql({ url: `file:${join(tmpDir, 'test.db')}` })
    // Likewise for busy_timeout: queued before return, so the value is set
    // by the time this query runs.
    const result = await client.execute('PRAGMA busy_timeout')
    // @libsql/client returns the timeout under the 'timeout' column
    expect(result.rows[0]['timeout']).toBe(5000)
  })
})

describe('withTransaction', () => {
  let tmpDir: string
  let client: Client

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-libsql-tx-test-'))
    client = openLibsql({ url: `file:${join(tmpDir, 'test.db')}` })
  })

  afterEach(() => {
    client.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('commits the callback result on success', async () => {
    await client.execute('CREATE TABLE items (value TEXT NOT NULL)')

    await withTransaction(client, async (tx) => {
      await tx.execute({ sql: "INSERT INTO items VALUES ('hello')", args: [] })
    })

    const result = await client.execute('SELECT value FROM items')
    expect(result.rows).toHaveLength(1)
    expect((result.rows[0] as unknown as { value: string }).value).toBe('hello')
  })

  it('rethrows the error from a failing callback', async () => {
    await client.execute('CREATE TABLE items (value TEXT NOT NULL)')

    await expect(
      withTransaction(client, async (_tx) => {
        throw new Error('deliberate failure')
      }),
    ).rejects.toThrow('deliberate failure')
  })

  it('rolls back writes from a failing callback', async () => {
    await client.execute('CREATE TABLE items (value TEXT NOT NULL)')

    await expect(
      withTransaction(client, async (tx) => {
        await tx.execute({
          sql: "INSERT INTO items VALUES ('rolled-back')",
          args: [],
        })
        throw new Error('deliberate failure')
      }),
    ).rejects.toThrow('deliberate failure')

    const result = await client.execute('SELECT COUNT(*) AS n FROM items')
    const n = Number(
      (result.rows[0] as unknown as { n: number | bigint }).n,
    )
    expect(n).toBe(0)
  })

  /**
   * This is the core hygiene test: a callback that throws must leave the
   * connection usable so a subsequent write succeeds immediately — proving
   * the ROLLBACK ran and no write lock was stranded (the root cause of the
   * 2026-07-03 and 2026-07-05 SQLITE_BUSY wedge incidents).
   */
  it('leaves the connection usable after a throwing callback (no stranded write lock)', async () => {
    await client.execute('CREATE TABLE items (value TEXT NOT NULL)')

    // First transaction: throws inside the callback.
    await expect(
      withTransaction(client, async (tx) => {
        await tx.execute({
          sql: "INSERT INTO items VALUES ('bad')",
          args: [],
        })
        throw new Error('deliberate failure')
      }),
    ).rejects.toThrow('deliberate failure')

    // Follow-up write on the same client must succeed immediately.
    // If the first call left an open write transaction, this would
    // fail with SQLITE_BUSY / "database is locked".
    await withTransaction(client, async (tx) => {
      await tx.execute({ sql: "INSERT INTO items VALUES ('good')", args: [] })
    })

    const result = await client.execute('SELECT value FROM items')
    expect(result.rows).toHaveLength(1)
    expect((result.rows[0] as unknown as { value: string }).value).toBe('good')
  })
})
