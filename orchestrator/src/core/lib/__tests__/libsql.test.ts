import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibsql, withTransaction } from '../libsql'
import type { DbClient } from '../db'

describe('openLibsql', () => {
  let tmpDir: string
  let client: DbClient

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-libsql-test-'))
  })

  afterEach(async () => {
    await client.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns a working DbClient that can execute basic SQL', async () => {
    // openLibsql is now a compatibility shim over openDb (PostgreSQL/PGlite).
    // SQLite PRAGMA statements no longer apply; verify the returned client
    // actually executes queries on the PostgreSQL layer.
    client = openLibsql({ url: `file:${join(tmpDir, 'test.db')}` })
    const result = await client.execute('SELECT 1 AS n')
    expect(result.rows[0]?.['n']).toBe(1)
  })

  it('the returned client can run DDL and DML', async () => {
    client = openLibsql({ url: `file:${join(tmpDir, 'test.db')}` })
    await client.execute('CREATE TABLE _smoke (v TEXT NOT NULL)')
    await client.execute({ sql: 'INSERT INTO _smoke VALUES (?)', args: ['hello'] })
    const result = await client.execute('SELECT v FROM _smoke')
    expect(result.rows[0]?.['v']).toBe('hello')
  })

  it('the returned client normalises int8 columns to JS numbers (migration 0002 compat)', async () => {
    // Columns typed as int8/bigint come back as JS numbers, not BigInt strings,
    // because the PGlite parser is configured with a numeric coercion.
    client = openLibsql({ url: `file:${join(tmpDir, 'test.db')}` })
    const result = await client.execute('SELECT 42::int8 AS n')
    expect(result.rows[0]?.['n']).toBe(42)
  })
})

describe('withTransaction', () => {
  let tmpDir: string
  let client: DbClient

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-libsql-tx-test-'))
    client = openLibsql({ url: `file:${join(tmpDir, 'test.db')}` })
  })

  afterEach(async () => {
    await client.close()
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
