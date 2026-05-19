import { DuckDBInstance, type DuckDBValue } from '@duckdb/node-api'

import { resolveContext } from '../context.js'

/*
 * Verbatim `span_events` DDL copied from `@mastra/duckdb`'s compiled
 * observability bundle (dist/observability-*.cjs, `SPAN_EVENTS_DDL`).
 * Inlined here so a reader can see the schema without spelunking
 * node_modules. Keep in sync if @mastra/duckdb ships a new column.
 *
 * CREATE TABLE IF NOT EXISTS span_events (
 *   -- Event metadata
 *   eventType VARCHAR NOT NULL,
 *   timestamp TIMESTAMP NOT NULL,
 *
 *   -- IDs
 *   traceId VARCHAR NOT NULL,
 *   spanId VARCHAR NOT NULL,
 *   parentSpanId VARCHAR,
 *   experimentId VARCHAR,
 *
 *   -- Entity
 *   entityType VARCHAR,
 *   entityId VARCHAR,
 *   entityName VARCHAR,
 *   entityVersionId VARCHAR,
 *
 *   -- Context
 *   userId VARCHAR,
 *   organizationId VARCHAR,
 *   resourceId VARCHAR,
 *   runId VARCHAR,
 *   sessionId VARCHAR,
 *   threadId VARCHAR,
 *   requestId VARCHAR,
 *   environment VARCHAR,
 *   source VARCHAR,
 *   serviceName VARCHAR,
 *   requestContext JSON,
 *
 *   -- Span-specific scalars
 *   name VARCHAR,
 *   spanType VARCHAR,
 *   isEvent BOOLEAN,
 *   endedAt TIMESTAMP,
 *
 *   -- JSON fields
 *   attributes JSON,
 *   metadata JSON,
 *   tags JSON,
 *   scope JSON,
 *   links JSON,
 *   input JSON,
 *   output JSON,
 *   error JSON
 * )
 */

/**
 * Run a parameterised SQL query against the orchestrator's observability
 * DuckDB database in read-only mode and return rows as plain objects.
 *
 * The database path is resolved from `resolveContext().observabilityDbPath`
 * — callers do not pass it in. The connection is opened read-only so
 * observability readers can coexist with a writer (`DuckDBStore`) holding
 * the single-writer lock on the same file.
 *
 * Parameters are positional; use `?` placeholders in the SQL.
 *
 * The connection and instance are closed before the promise resolves so
 * the caller does not have to manage handles.
 */
export const querySpanEvents = async (
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> => {
  const { observabilityDbPath } = resolveContext()
  const instance = await DuckDBInstance.create(observabilityDbPath, {
    access_mode: 'read_only',
  })
  try {
    const connection = await instance.connect()
    try {
      const reader = await connection.runAndReadAll(
        sql,
        params as DuckDBValue[],
      )
      return reader.getRowObjectsJS() as Record<string, unknown>[]
    } finally {
      connection.closeSync()
    }
  } finally {
    instance.closeSync()
  }
}
