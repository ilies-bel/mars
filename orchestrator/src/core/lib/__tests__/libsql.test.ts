import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibsql } from '../libsql'
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
