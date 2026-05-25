import { DuckDBInstance, type DuckDBValue } from '@duckdb/node-api'

/**
 * Mars's own trace-event store.
 *
 * This is deliberately a *separate* DuckDB file from the framework's
 * observability store (`observability.duckdb`, written by `@mastra/duckdb`).
 * The observability store records what the Mastra framework instrumented;
 * this store records what Mars itself did — a closed set of named lifecycle
 * events tagged with a timestamp, the origin they belong to, and the task or
 * idea that owns them. Keeping the files physically separate means the Mars
 * origin timeline is never diluted by framework-authored spans.
 */

/**
 * The closed set of lifecycle event names Mars records. New event kinds are
 * added here (and only here) so the timeline vocabulary stays bounded.
 */
export const TRACE_EVENT_NAMES = [
  'origin_created',
  'task_dispatched',
  'task_completed',
  'task_failed',
  'task_blocked',
  'origin_done',
] as const

export type TraceEventName = (typeof TRACE_EVENT_NAMES)[number]

/** Whether a lifecycle event belongs to a task or an idea (origin). */
export type TraceEventOwnerKind = 'task' | 'idea'

export interface TraceEvent {
  /** When the event happened. */
  timestamp: Date
  /** The origin (idea) this event ultimately rolls up to. */
  originId: string
  /** Whether `ownerId` names a task or an idea. */
  ownerKind: TraceEventOwnerKind
  /** The task or idea the event belongs to. */
  ownerId: string
  /** One of the closed set of lifecycle event names. */
  eventName: TraceEventName
}

export interface TraceEventStore {
  /** Append one lifecycle event to the store. */
  record: (event: TraceEvent) => Promise<void>
  /** Release the DuckDB single-writer lock on the underlying file. */
  close: () => void
}

const TRACE_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS mars_trace_events (
  timestamp TIMESTAMP NOT NULL,
  origin_id VARCHAR NOT NULL,
  owner_kind VARCHAR NOT NULL,
  owner_id VARCHAR NOT NULL,
  event_name VARCHAR NOT NULL
)
`

const INSERT_EVENT_SQL = `
INSERT INTO mars_trace_events
  (timestamp, origin_id, owner_kind, owner_id, event_name)
VALUES (CAST(? AS TIMESTAMP), ?, ?, ?, ?)
`

/**
 * Open (creating it if absent) the Mars trace-event store at `path` and
 * ensure its schema exists. Opening acquires DuckDB's single-writer lock on
 * the file, so a second opener in another process fails fast — that is what
 * stops two daemons from racing on the same repo's timeline.
 *
 * The caller owns the returned handle and must `close()` it to release the
 * lock.
 */
export const openTraceEventStore = async (
  path: string,
): Promise<TraceEventStore> => {
  const instance = await DuckDBInstance.create(path)
  const connection = await instance.connect()
  await connection.run(TRACE_EVENTS_DDL)

  return {
    record: async (event: TraceEvent): Promise<void> => {
      await connection.run(INSERT_EVENT_SQL, [
        event.timestamp.toISOString(),
        event.originId,
        event.ownerKind,
        event.ownerId,
        event.eventName,
      ] as DuckDBValue[])
    },
    close: (): void => {
      connection.closeSync()
      instance.closeSync()
    },
  }
}
