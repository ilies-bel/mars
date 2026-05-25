import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DuckDBInstance } from '@duckdb/node-api'

import { __resetContextCacheForTests } from '../../context.js'
import { querySpanEvents } from '../observability-spans.js'

// The DDL the helper inlines as a comment block. The test materialises
// it verbatim so any drift between the inlined schema and what
// `querySpanEvents` actually expects shows up as a failed insert.
const SPAN_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS span_events (
  eventType VARCHAR NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  traceId VARCHAR NOT NULL,
  spanId VARCHAR NOT NULL,
  parentSpanId VARCHAR,
  experimentId VARCHAR,
  entityType VARCHAR,
  entityId VARCHAR,
  entityName VARCHAR,
  entityVersionId VARCHAR,
  userId VARCHAR,
  organizationId VARCHAR,
  resourceId VARCHAR,
  runId VARCHAR,
  sessionId VARCHAR,
  threadId VARCHAR,
  requestId VARCHAR,
  environment VARCHAR,
  source VARCHAR,
  serviceName VARCHAR,
  requestContext JSON,
  name VARCHAR,
  spanType VARCHAR,
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
)`

describe('querySpanEvents', () => {
  let tmpRoot: string
  let originalMarsRepo: string | undefined

  beforeEach(async () => {
    originalMarsRepo = process.env.MARS_REPO
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'mars-observability-spans-'))
    // The helper resolves the observability db path from
    // `resolveContext()`, which honours `MARS_REPO` before falling back
    // to git toplevel detection.
    process.env.MARS_REPO = tmpRoot
    __resetContextCacheForTests()
    mkdirSync(resolve(tmpRoot, '.mars'), { recursive: true })

    // Seed the observability database at the path
    // `resolveContext()` will hand back: `<repo>/.mars/observability.duckdb`.
    const dbPath = resolve(tmpRoot, '.mars', 'observability.duckdb')
    const instance = await DuckDBInstance.create(dbPath)
    const connection = await instance.connect()
    try {
      await connection.run(SPAN_EVENTS_DDL)
      await connection.run(
        `INSERT INTO span_events (eventType, timestamp, traceId, spanId, metadata)
         VALUES ('span', TIMESTAMP '2026-01-01 00:00:00', 't1', 's1', '{"originId":"x"}')`,
      )
      await connection.run(
        `INSERT INTO span_events (eventType, timestamp, traceId, spanId, metadata)
         VALUES ('span', TIMESTAMP '2026-01-01 00:00:01', 't2', 's2', '{"originId":"y"}')`,
      )
    } finally {
      connection.closeSync()
      instance.closeSync()
    }
  })

  afterEach(() => {
    __resetContextCacheForTests()
    if (originalMarsRepo === undefined) {
      delete process.env.MARS_REPO
    } else {
      process.env.MARS_REPO = originalMarsRepo
    }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('returns rows matching a parameterised originId filter against the inlined DDL', async () => {
    const rows = await querySpanEvents(
      `SELECT traceId, spanId, metadata
       FROM span_events
       WHERE json_extract_string(metadata, '$.originId') = ?`,
      ['x'],
    )

    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row.traceId).toBe('t1')
    expect(row.spanId).toBe('s1')
    // Verify JSON columns are returned as strings by the helper.
    expect(String(row.metadata)).toContain('"originId"')
  })
})
