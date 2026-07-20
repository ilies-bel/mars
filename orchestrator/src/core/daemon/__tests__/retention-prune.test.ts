/**
 * Retention sweep behaviour tests.
 *
 * All tests drive `pruneRetention` through its public interface and assert on
 * observable side-effects (row counts and surviving rows). No internals are
 * tested; every assertion would survive a full implementation rewrite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { openLibsql } from '../../lib/libsql'
import {
  pruneRetention,
  RETENTION_DAYS_DEFAULT,
  RETENTION_MAX_ROWS_DEFAULT,
  LOG_LINE_RETENTION_DAYS,
} from '../../lib/retention-prune'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTs(offsetDays: number): string {
  return new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString()
}

type LibsqlClient = ReturnType<typeof openLibsql>

async function setupTables(client: LibsqlClient): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS trace_events (
      id        TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      kind      TEXT NOT NULL DEFAULT 'test',
      severity  TEXT NOT NULL DEFAULT 'info',
      task_id   TEXT,
      origin_id TEXT,
      phase     TEXT,
      payload   TEXT NOT NULL DEFAULT '{}'
    )
  `)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      type    TEXT    NOT NULL DEFAULT 'test',
      payload TEXT    NOT NULL DEFAULT '{}',
      ts      INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS subscriber_processed_events (
      subscriber_id TEXT    NOT NULL,
      event_id      INTEGER NOT NULL,
      processed_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (subscriber_id, event_id)
    )
  `)
}

async function seedTraceEvent(
  client: LibsqlClient,
  id: string,
  timestamp: string,
  kind = 'test',
): Promise<void> {
  await client.execute({
    sql: 'INSERT INTO trace_events (id, timestamp, kind) VALUES (?, ?, ?)',
    args: [id, timestamp, kind],
  })
}

async function traceEventIds(client: LibsqlClient): Promise<string[]> {
  const r = await client.execute('SELECT id FROM trace_events ORDER BY timestamp ASC')
  return r.rows.map((row) => (row as unknown as { id: string }).id)
}

async function traceEventCount(client: LibsqlClient): Promise<number> {
  const r = await client.execute('SELECT COUNT(*) AS n FROM trace_events')
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

async function seedEvent(client: LibsqlClient): Promise<number> {
  await client.execute(
    "INSERT INTO events (type, payload) VALUES ('test', '{}')",
  )
  const r = await client.execute('SELECT last_insert_rowid() AS id')
  return Number((r.rows[0] as unknown as { id: number | bigint }).id)
}

async function seedDedup(
  client: LibsqlClient,
  subscriberId: string,
  eventId: number,
): Promise<void> {
  await client.execute({
    sql: 'INSERT INTO subscriber_processed_events (subscriber_id, event_id) VALUES (?, ?)',
    args: [subscriberId, eventId],
  })
}

async function dedupCount(client: LibsqlClient): Promise<number> {
  const r = await client.execute(
    'SELECT COUNT(*) AS n FROM subscriber_processed_events',
  )
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

// ── test fixture ─────────────────────────────────────────────────────────────

describe('pruneRetention', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-retention-'))
    dbPath = resolve(tmpDir, 'mars.db')

    const client = openLibsql({ url: `file:${dbPath}` })
    await setupTables(client)
    client.close()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── trace_events: age-based prune ────────────────────────────────────────

  it('removes trace_events older than maxAgeDays and keeps recent ones', async () => {
    const client = openLibsql({ url: `file:${dbPath}` })

    // Seed two rows beyond the retention horizon and one within it.
    await seedTraceEvent(client, 'old-1', makeTs(RETENTION_DAYS_DEFAULT + 1))
    await seedTraceEvent(client, 'old-2', makeTs(RETENTION_DAYS_DEFAULT + 5))
    await seedTraceEvent(client, 'recent', makeTs(1))

    client.close()

    const result = await pruneRetention(dbPath)

    expect(result.traceEventsByAge).toBe(2)

    const client2 = openLibsql({ url: `file:${dbPath}` })
    const ids = await traceEventIds(client2)
    client2.close()

    expect(ids).toHaveLength(1)
    expect(ids).toContain('recent')
  })

  it('returns zero traceEventsByAge when all rows are within the retention window', async () => {
    const client = openLibsql({ url: `file:${dbPath}` })
    await seedTraceEvent(client, 'r1', makeTs(1))
    await seedTraceEvent(client, 'r2', makeTs(2))
    client.close()

    const result = await pruneRetention(dbPath)

    expect(result.traceEventsByAge).toBe(0)
  })

  // ── trace_events: row-count cap ───────────────────────────────────────────

  it('trims oldest trace_events when the table exceeds maxRows', async () => {
    const maxRows = 5
    const client = openLibsql({ url: `file:${dbPath}` })

    // Insert 8 recent rows at slightly different timestamps so ordering is
    // deterministic (newest last).
    const base = Date.now()
    for (let i = 0; i < 8; i++) {
      const ts = new Date(base - (8 - i) * 1000).toISOString()
      await seedTraceEvent(client, `row-${i}`, ts)
    }
    client.close()

    const result = await pruneRetention(dbPath, { maxRows, maxAgeDays: 0 })

    // Should have trimmed 3 rows (8 - 5 = 3), bounded by default batchSize.
    expect(result.traceEventsByCount).toBe(3)

    // Verify the 5 most-recent rows survived (row-3 through row-7).
    const client2 = openLibsql({ url: `file:${dbPath}` })
    const count = await traceEventCount(client2)
    const ids = await traceEventIds(client2)
    client2.close()

    expect(count).toBe(maxRows)
    // row-0, row-1, row-2 (the oldest) should be gone.
    expect(ids).not.toContain('row-0')
    expect(ids).not.toContain('row-1')
    expect(ids).not.toContain('row-2')
    // row-7 (the newest) must survive.
    expect(ids).toContain('row-7')
  })

  it('returns zero traceEventsByCount when row count is at or below maxRows', async () => {
    const client = openLibsql({ url: `file:${dbPath}` })
    await seedTraceEvent(client, 'only', makeTs(1))
    client.close()

    const result = await pruneRetention(dbPath, {
      maxRows: RETENTION_MAX_ROWS_DEFAULT,
      maxAgeDays: 0,
    })

    expect(result.traceEventsByCount).toBe(0)
  })

  it('respects batchSize and does not delete more than the batch ceiling', async () => {
    const client = openLibsql({ url: `file:${dbPath}` })

    // 10 old rows, batchSize=4 — at most 4 should be removed per call.
    for (let i = 0; i < 10; i++) {
      await seedTraceEvent(client, `old-${i}`, makeTs(RETENTION_DAYS_DEFAULT + 10))
    }
    client.close()

    const result = await pruneRetention(dbPath, { batchSize: 4 })

    // Either deleted by age or by count, but never more than batchSize.
    const deletedThisPass = result.traceEventsByAge + result.traceEventsByCount
    expect(deletedThisPass).toBeLessThanOrEqual(4)
  })

  // ── subscriber_processed_events: orphan prune ─────────────────────────────

  it('removes dedup rows whose event_id is absent from the events table', async () => {
    const client = openLibsql({ url: `file:${dbPath}` })

    // Insert one live event and two phantom event IDs (never in events).
    const liveId = await seedEvent(client)
    await seedDedup(client, 'sub-a', liveId) // live — must survive
    await seedDedup(client, 'sub-a', 9999) // orphan — event 9999 never existed
    await seedDedup(client, 'sub-b', 8888) // orphan — event 8888 never existed

    client.close()

    const result = await pruneRetention(dbPath, { maxAgeDays: 0, maxRows: 9999 })

    expect(result.subscriberProcessedEvents).toBe(2)

    const client2 = openLibsql({ url: `file:${dbPath}` })
    const remaining = await dedupCount(client2)
    client2.close()

    expect(remaining).toBe(1) // only the live-event dedup row survives
  })

  it('preserves dedup rows whose event_id still exists in the events table', async () => {
    const client = openLibsql({ url: `file:${dbPath}` })

    const id1 = await seedEvent(client)
    const id2 = await seedEvent(client)
    await seedDedup(client, 'sub-a', id1)
    await seedDedup(client, 'sub-a', id2)

    client.close()

    const result = await pruneRetention(dbPath, { maxAgeDays: 0, maxRows: 9999 })

    expect(result.subscriberProcessedEvents).toBe(0)

    const client2 = openLibsql({ url: `file:${dbPath}` })
    expect(await dedupCount(client2)).toBe(2)
    client2.close()
  })

  it('returns zero subscriberProcessedEvents when events table is absent', async () => {
    // Canonical PostgreSQL provisioning creates the outbox tables together.
    // An untouched database is therefore the equivalent no-orphans case.
    const isolatedDir = mkdtempSync(resolve(tmpdir(), 'mars-no-events-'))
    const isolatedPath = resolve(isolatedDir, 'mars.db')
    try {
      const result = await pruneRetention(isolatedPath, { maxAgeDays: 0, maxRows: 9999 })

      expect(result.subscriberProcessedEvents).toBe(0)
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true })
    }
  })

  // ── row-cap: looping until convergence ──────────────────────────────────

  it('row-cap prune loops until row count is at or below maxRows (5k → 1k)', async () => {
    const client = openLibsql({ url: `file:${dbPath}` })
    const base = Date.now()
    for (let i = 0; i < 5000; i++) {
      const ts = new Date(base - (5000 - i) * 1000).toISOString()
      await client.execute({
        sql: `INSERT INTO trace_events (id, timestamp, kind, severity, payload)
              VALUES (?, ?, 'log_line', 'info', '{}')`,
        args: [`bulk-${i}`, ts],
      })
    }
    client.close()

    await pruneRetention(dbPath, { maxRows: 1000, maxAgeDays: 0, maxLogLineAgeDays: 0 })

    const client2 = openLibsql({ url: `file:${dbPath}` })
    const count = await traceEventCount(client2)
    client2.close()

    expect(count).toBeLessThanOrEqual(1000)
  })

  it('traceEventsRemaining reflects the actual post-prune row count', async () => {
    const client = openLibsql({ url: `file:${dbPath}` })
    await seedTraceEvent(client, 'r1', makeTs(1))
    await seedTraceEvent(client, 'r2', makeTs(1))
    await seedTraceEvent(client, 'r3', makeTs(1))
    client.close()

    const result = await pruneRetention(dbPath, { maxAgeDays: 0, maxRows: 9999 })

    expect(result.traceEventsRemaining).toBe(3)
  })

  // ── log_line tight age cap ────────────────────────────────────────────────

  it('deletes log_line rows older than maxLogLineAgeDays and keeps recent ones', async () => {
    const client = openLibsql({ url: `file:${dbPath}` })
    // Two stale log_line rows (beyond 2-day cap) and one recent one.
    await seedTraceEvent(client, 'logline-old-1', makeTs(LOG_LINE_RETENTION_DAYS + 1), 'log_line')
    await seedTraceEvent(client, 'logline-old-2', makeTs(LOG_LINE_RETENTION_DAYS + 3), 'log_line')
    await seedTraceEvent(client, 'logline-fresh', makeTs(0), 'log_line')
    // A regular event also older than log_line cap — must NOT be deleted by log_line pass.
    await seedTraceEvent(client, 'step-old', makeTs(LOG_LINE_RETENTION_DAYS + 1), 'step_ended')
    client.close()

    const result = await pruneRetention(dbPath, { maxAgeDays: 0, maxRows: 9999 })

    expect(result.traceEventsByLogLineAge).toBe(2)

    const client2 = openLibsql({ url: `file:${dbPath}` })
    const ids = await traceEventIds(client2)
    client2.close()

    // Fresh log_line and the non-log_line event survive.
    expect(ids).toContain('logline-fresh')
    expect(ids).toContain('step-old')
    expect(ids).not.toContain('logline-old-1')
    expect(ids).not.toContain('logline-old-2')
  })

  it('returns zero traceEventsByLogLineAge when maxLogLineAgeDays is 0', async () => {
    const client = openLibsql({ url: `file:${dbPath}` })
    await seedTraceEvent(client, 'logline-stale', makeTs(LOG_LINE_RETENTION_DAYS + 5), 'log_line')
    client.close()

    const result = await pruneRetention(dbPath, { maxAgeDays: 0, maxLogLineAgeDays: 0, maxRows: 9999 })

    expect(result.traceEventsByLogLineAge).toBe(0)
  })

  // ── combined pass ─────────────────────────────────────────────────────────

  it('prunes both trace_events and subscriber_processed_events in one call', async () => {
    const client = openLibsql({ url: `file:${dbPath}` })

    // Old telemetry row.
    await seedTraceEvent(client, 'old', makeTs(RETENTION_DAYS_DEFAULT + 2))
    // Recent telemetry row.
    await seedTraceEvent(client, 'fresh', makeTs(0))

    // Live event + one orphaned dedup entry.
    const liveId = await seedEvent(client)
    await seedDedup(client, 'sub', liveId)
    await seedDedup(client, 'sub', 7777) // orphan

    client.close()

    const result = await pruneRetention(dbPath)

    expect(result.traceEventsByAge).toBe(1)
    expect(result.subscriberProcessedEvents).toBe(1)

    const client2 = openLibsql({ url: `file:${dbPath}` })
    const ids = await traceEventIds(client2)
    const dedup = await dedupCount(client2)
    client2.close()

    expect(ids).toEqual(['fresh'])
    expect(dedup).toBe(1)
  })
})
