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
    // Give the fire-and-forget PRAGMA a tick to settle
    await new Promise(r => setTimeout(r, 0))
    const result = await client.execute('PRAGMA foreign_keys')
    expect(result.rows[0]['foreign_keys']).toBe(1)
  })
})
