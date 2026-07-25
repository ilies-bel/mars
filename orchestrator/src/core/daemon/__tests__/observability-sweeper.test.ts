import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { openLibsql } from '../../lib/libsql'
import { OBSERVABILITY_RETENTION_DAYS, sweepObservability } from '../observability-sweeper'

const seedEvent = async (
  client: ReturnType<typeof openLibsql>,
  id: string,
  timestamp: string,
): Promise<void> => {
  await client.execute({
    sql: 'INSERT INTO trace_events (id, timestamp, kind, severity, payload) VALUES (?, ?, ?, ?, ?)',
    args: [id, timestamp, 'origin_created', 'info', '{}'],
  })
}

describe('sweepObservability', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-obs-sweeper-'))
    dbPath = resolve(tmpDir, 'mars.db')
    // Pre-create the table so tests can seed rows before the first sweep
    const client = openLibsql({ url: `file:${dbPath}` })
    await client.execute(`
      CREATE TABLE IF NOT EXISTS trace_events (
        id        TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        kind      TEXT NOT NULL,
        severity  TEXT NOT NULL DEFAULT 'info',
        task_id   TEXT,
        origin_id TEXT,
        phase     TEXT,
        payload   TEXT NOT NULL DEFAULT '{}'
      )
    `)
    client.close()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes rows older than three days and keeps recent rows', async () => {
    // Seed two old rows (4 days ago) and one recent row (1 day ago)
    const oldTs = new Date(
      Date.now() - (OBSERVABILITY_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString()
    const recentTs = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()

    const client = openLibsql({ url: `file:${dbPath}` })
    await seedEvent(client, 'old-1', oldTs)
    await seedEvent(client, 'old-2', oldTs)
    await seedEvent(client, 'recent-1', recentTs)
    client.close()

    const deleted = await sweepObservability(dbPath)

    // Two old rows were removed
    expect(deleted).toBe(2)

    // Recent row survived
    const client2 = openLibsql({ url: `file:${dbPath}` })
    const result = await client2.execute('SELECT id FROM trace_events')
    client2.close()

    const ids = result.rows.map((r) => (r as unknown as { id: string }).id)
    expect(ids).toHaveLength(1)
    expect(ids).toContain('recent-1')
  })

  it('returns zero when there are no rows older than three days', async () => {
    const recentTs = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()

    const client = openLibsql({ url: `file:${dbPath}` })
    await seedEvent(client, 'recent-1', recentTs)
    client.close()

    const deleted = await sweepObservability(dbPath)

    expect(deleted).toBe(0)

    // Row is still there
    const client2 = openLibsql({ url: `file:${dbPath}` })
    const result = await client2.execute('SELECT id FROM trace_events')
    client2.close()
    expect(result.rows).toHaveLength(1)
  })

  it('returns zero on an empty store', async () => {
    const deleted = await sweepObservability(dbPath)
    expect(deleted).toBe(0)
  })
})
