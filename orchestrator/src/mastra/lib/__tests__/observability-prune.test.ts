import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openLibsql } from '../libsql'
import { pruneObservability } from '../observability-prune'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-obs-prune-'))
  return join(dir, 'mars.db')
}

const TRACE_DDL = `
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
`

const INSERT_ROW = `
  INSERT INTO trace_events (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`

/** ISO timestamp offset from now by `offsetMs` milliseconds (negative = past). */
const isoOffset = (offsetMs: number): string =>
  new Date(Date.now() + offsetMs).toISOString()

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pruneObservability — age-based deletion', () => {
  it('removes rows older than maxAgeDays and leaves newer rows intact', async () => {
    const dbPath = tmpDbPath()
    const client = openLibsql({ url: `file:${dbPath}` })
    try {
      await client.execute(TRACE_DDL)

      // 4 days old — should be pruned at default 3-day threshold
      const oldTs = isoOffset(-4 * 24 * 60 * 60 * 1000)
      // 1 hour old — should survive
      const recentTs = isoOffset(-60 * 60 * 1000)

      await client.execute({
        sql: INSERT_ROW,
        args: ['old-1', oldTs, 'task_failed', 'error', null, null, null, '{}'],
      })
      await client.execute({
        sql: INSERT_ROW,
        args: [
          'recent-1',
          recentTs,
          'step_started',
          'info',
          null,
          null,
          null,
          '{}',
        ],
      })

      const deleted = await pruneObservability(dbPath, 3)

      expect(deleted).toBe(1)

      const remaining = await client.execute(
        'SELECT id FROM trace_events ORDER BY id',
      )
      expect(remaining.rows).toHaveLength(1)
      expect(remaining.rows[0].id).toBe('recent-1')
    } finally {
      client.close()
    }
  })

  it('leaves rows intact when none are older than maxAgeDays', async () => {
    const dbPath = tmpDbPath()
    const client = openLibsql({ url: `file:${dbPath}` })
    try {
      await client.execute(TRACE_DDL)
      const ts = isoOffset(-60 * 60 * 1000) // 1 hour ago
      await client.execute({
        sql: INSERT_ROW,
        args: ['r1', ts, 'step_started', 'info', null, null, null, '{}'],
      })

      const deleted = await pruneObservability(dbPath, 3)

      expect(deleted).toBe(0)
      const remaining = await client.execute('SELECT id FROM trace_events')
      expect(remaining.rows).toHaveLength(1)
    } finally {
      client.close()
    }
  })
})

describe('pruneObservability — wipe all (maxAgeDays = 0)', () => {
  it('removes all rows when maxAgeDays is 0', async () => {
    const dbPath = tmpDbPath()
    const client = openLibsql({ url: `file:${dbPath}` })
    try {
      await client.execute(TRACE_DDL)

      const oldTs = isoOffset(-10 * 24 * 60 * 60 * 1000)
      const recentTs = isoOffset(-60 * 60 * 1000)

      await client.execute({
        sql: INSERT_ROW,
        args: ['row-1', oldTs, 'task_failed', 'error', null, null, null, '{}'],
      })
      await client.execute({
        sql: INSERT_ROW,
        args: [
          'row-2',
          recentTs,
          'step_started',
          'info',
          null,
          null,
          null,
          '{}',
        ],
      })

      const deleted = await pruneObservability(dbPath, 0)

      expect(deleted).toBe(2)
      const remaining = await client.execute('SELECT id FROM trace_events')
      expect(remaining.rows).toHaveLength(0)
    } finally {
      client.close()
    }
  })
})

describe('pruneObservability — edge cases', () => {
  it('returns 0 and does not error when the store is empty', async () => {
    const dbPath = tmpDbPath()
    const client = openLibsql({ url: `file:${dbPath}` })
    try {
      await client.execute(TRACE_DDL)
      const deleted = await pruneObservability(dbPath, 3)
      expect(deleted).toBe(0)
    } finally {
      client.close()
    }
  })

  it('creates the table and returns 0 when the DB file is brand new', async () => {
    // Simulates running prune before the daemon has ever started
    const dbPath = tmpDbPath()
    const deleted = await pruneObservability(dbPath, 3)
    expect(deleted).toBe(0)

    // Table now exists — a second prune still works
    const deleted2 = await pruneObservability(dbPath, 3)
    expect(deleted2).toBe(0)
  })

  it('does not error when a second connection holds the file open (concurrent-access)', async () => {
    // Simulates the daemon holding the DB open while prune runs
    const dbPath = tmpDbPath()
    const daemonConn = openLibsql({ url: `file:${dbPath}` })
    try {
      await daemonConn.execute(TRACE_DDL)
      const ts = isoOffset(-5 * 24 * 60 * 60 * 1000)
      await daemonConn.execute({
        sql: INSERT_ROW,
        args: ['d1', ts, 'task_failed', 'error', null, null, null, '{}'],
      })

      // prune via a different connection — must not throw
      const deleted = await pruneObservability(dbPath, 3)
      expect(deleted).toBe(1)
    } finally {
      daemonConn.close()
    }
  })
})
