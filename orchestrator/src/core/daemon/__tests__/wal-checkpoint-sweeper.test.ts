import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { openLibsql } from '../../lib/libsql'
import { sweepWalCheckpoint } from '../wal-checkpoint-sweeper'

describe('sweepWalCheckpoint', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-wal-checkpoint-'))
    dbPath = resolve(tmpDir, 'mars.db')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns a valid (busy, log, checkpointed) triple without throwing', async () => {
    const client = openLibsql({ url: `file:${dbPath}` })
    await client.execute(
      'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, val TEXT)',
    )

    const result = await sweepWalCheckpoint(client)

    expect(typeof result.busy).toBe('number')
    expect(typeof result.log).toBe('number')
    expect(typeof result.checkpointed).toBe('number')
    // checkpointed can never exceed log
    expect(result.checkpointed).toBeLessThanOrEqual(result.log)

    client.close()
  })

  it('checkpoints WAL frames and shrinks the WAL file after writes', async () => {
    const walPath = `${dbPath}-wal`
    const client = openLibsql({ url: `file:${dbPath}` })

    // Explicitly enable WAL mode and disable autocheckpoint so that writes
    // accumulate in the WAL file instead of being folded back into the main
    // DB automatically.
    await client.execute('PRAGMA journal_mode = WAL')
    await client.execute('PRAGMA wal_autocheckpoint = 0')
    await client.execute(
      'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, val TEXT)',
    )

    // Write enough rows to grow the WAL file visibly
    for (let i = 0; i < 1000; i++) {
      await client.execute({
        sql: 'INSERT INTO t (val) VALUES (?)',
        args: [`${'x'.repeat(100)}-${i}`],
      })
    }

    const walSizeBefore = existsSync(walPath) ? statSync(walPath).size : 0
    expect(walSizeBefore).toBeGreaterThan(0)

    const result = await sweepWalCheckpoint(client)

    if (result.busy === 0) {
      // Successful TRUNCATE: the WAL file must have been truncated (or
      // removed) — it should be strictly smaller than before.
      const walSizeAfter = existsSync(walPath) ? statSync(walPath).size : 0
      expect(walSizeAfter).toBeLessThan(walSizeBefore)
    } else {
      // Blocked by a concurrent reader — acceptable; the function must not
      // throw, and some frames may still have been checkpointed.
      expect(result.busy).toBe(1)
    }

    client.close()
  })
})
