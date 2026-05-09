import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DuckDBConnection } from '@mastra/duckdb'
import { querySpans } from '../spans'

// Schema mirror of @mastra/duckdb's span_events table — we recreate just
// enough of it to drive querySpans against a real DuckDB instance, without
// booting the full Mastra observability stack.
const CREATE_SPAN_EVENTS_SQL = `
  CREATE TABLE span_events (
    eventType TEXT,
    timestamp TIMESTAMP,
    traceId TEXT,
    spanId TEXT,
    parentSpanId TEXT,
    experimentId TEXT,
    entityType TEXT,
    entityId TEXT,
    entityName TEXT,
    entityVersionId TEXT,
    userId TEXT,
    organizationId TEXT,
    resourceId TEXT,
    runId TEXT,
    sessionId TEXT,
    threadId TEXT,
    requestId TEXT,
    environment TEXT,
    source TEXT,
    serviceName TEXT,
    requestContext JSON,
    name TEXT,
    spanType TEXT,
    isEvent BOOLEAN,
    endedAt TIMESTAMP,
    attributes JSON,
    metadata JSON,
    tags JSON,
    scope JSON,
    links JSON,
    input JSON,
    output JSON,
    error JSON
  )
`

describe('querySpans against a real DuckDB instance', () => {
  let dir: string
  let dbPath: string
  let db: DuckDBConnection

  beforeEach(async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'mars-spans-test-'))
    dbPath = resolve(dir, 'spans.duckdb')
    db = new DuckDBConnection({ path: dbPath })
    await db.execute(CREATE_SPAN_EVENTS_SQL)
  })

  afterEach(async () => {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const insert = async (row: {
    spanId: string
    traceId: string
    runId: string
    timestamp: string
    attributes: object
    output?: object
  }): Promise<void> => {
    await db.execute(
      `INSERT INTO span_events (eventType, timestamp, traceId, spanId, runId, name, attributes, output)
       VALUES (?, CAST(? AS TIMESTAMP), ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON))`,
      [
        'span',
        row.timestamp,
        row.traceId,
        row.spanId,
        row.runId,
        'test-span',
        JSON.stringify(row.attributes),
        JSON.stringify(row.output ?? { ok: true }),
      ],
    )
  }

  it('by-task uses DuckDB JSON path extraction on attributes', async () => {
    await insert({
      spanId: 's1',
      traceId: 't1',
      runId: 'r1',
      timestamp: '2026-01-01 00:00:00',
      attributes: { taskId: 'task-A' },
    })
    await insert({
      spanId: 's2',
      traceId: 't2',
      runId: 'r2',
      timestamp: '2026-01-01 00:01:00',
      attributes: { taskId: 'task-B' },
    })
    await insert({
      spanId: 's3',
      traceId: 't3',
      runId: 'r3',
      timestamp: '2026-01-01 00:02:00',
      attributes: { taskId: 'task-A', extra: 'x' },
    })

    const res = await querySpans(db, { kind: 'by-task', id: 'task-A' })
    expect(res.total).toBe(2)
    expect(res.rows.map((r) => r.spanId).sort()).toEqual(['s1', 's3'])
    expect(res.rows[0]?.attributes).toMatchObject({ taskId: 'task-A' })
  })

  it('by-run filters on runId', async () => {
    await insert({
      spanId: 's1',
      traceId: 't1',
      runId: 'run-1',
      timestamp: '2026-01-01 00:00:00',
      attributes: {},
    })
    await insert({
      spanId: 's2',
      traceId: 't2',
      runId: 'run-2',
      timestamp: '2026-01-01 00:01:00',
      attributes: {},
    })

    const res = await querySpans(db, { kind: 'by-run', id: 'run-1' })
    expect(res.total).toBe(1)
    expect(res.rows[0]?.spanId).toBe('s1')
  })

  it('by-trace filters on traceId', async () => {
    await insert({
      spanId: 's1',
      traceId: 'trace-A',
      runId: 'r',
      timestamp: '2026-01-01 00:00:00',
      attributes: {},
    })
    await insert({
      spanId: 's2',
      traceId: 'trace-A',
      runId: 'r',
      timestamp: '2026-01-01 00:01:00',
      attributes: {},
    })
    await insert({
      spanId: 's3',
      traceId: 'trace-B',
      runId: 'r',
      timestamp: '2026-01-01 00:02:00',
      attributes: {},
    })

    const res = await querySpans(db, { kind: 'by-trace', id: 'trace-A' })
    expect(res.total).toBe(2)
    expect(res.rows.map((r) => r.spanId).sort()).toEqual(['s1', 's2'])
  })

  it('truncated reflects total > offset + rows', async () => {
    for (let i = 0; i < 5; i++) {
      await insert({
        spanId: `s${i}`,
        traceId: 't',
        runId: 'run-x',
        timestamp: `2026-01-01 00:00:0${i}`,
        attributes: {},
      })
    }
    const res = await querySpans(db, {
      kind: 'by-run',
      id: 'run-x',
      limit: 2,
    })
    expect(res.total).toBe(5)
    expect(res.rows).toHaveLength(2)
    expect(res.truncated).toBe(true)
  })
})
