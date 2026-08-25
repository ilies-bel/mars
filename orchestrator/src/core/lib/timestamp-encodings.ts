/**
 * Timestamp encodings for the canonical tables that test fixtures seed
 * directly. Keep this registry beside the database seam so a fixture cannot
 * accidentally choose its own representation, and so operators can look up
 * the correct SQL display expression for any table.
 *
 * Encoding key:
 *   'iso-8601'     — PostgreSQL timestamptz; display with to_char(col, 'MM-DD HH24:MI')
 *   'epoch-millis' — bigint epoch-milliseconds; display with
 *                    to_char(to_timestamp(col / 1000.0), 'MM-DD HH24:MI')
 *
 * When a new table is added to the DDL with timestamp columns, add it here
 * AND update the doc comment in pg-schema.ts AND both timestamp tables in
 * CLAUDE.md. The exhaustiveness test in
 * __tests__/timestamp-encodings.test.ts will fail if this registry drifts.
 */
export const FIXTURE_TIMESTAMP_ENCODINGS = {
  /** timestamptz — to_char(created_at, 'MM-DD HH24:MI') */
  tasks: {
    created_at: 'iso-8601',
    updated_at: 'iso-8601',
  },
  /** bigint epoch-ms — to_char(to_timestamp(created_at / 1000.0), 'MM-DD HH24:MI') */
  proposals: {
    created_at: 'epoch-millis',
    updated_at: 'epoch-millis',
  },
  /** bigint epoch-ms — to_char(to_timestamp(created_at / 1000.0), 'MM-DD HH24:MI') */
  chat_threads: {
    created_at: 'epoch-millis',
    updated_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  task_blockers: {
    created_at: 'epoch-millis',
  },
  /**
   * bigint epoch-ms; creation column is raised_at (not created_at);
   * lifecycle column is status (not state).
   */
  action_queue_items: {
    raised_at: 'epoch-millis',
    resolved_at: 'epoch-millis',
    last_seen_at: 'epoch-millis',
    snoozed_until: 'epoch-millis',
  },
  /** bigint epoch-ms */
  self_heal_attempts: {
    created_at: 'epoch-millis',
  },
  /** bigint epoch-ms; column is named `timestamp`, not `created_at` */
  trace_events: {
    timestamp: 'epoch-millis',
  },
  /** bigint epoch-ms; column is named `ts`, not `created_at` */
  events: {
    ts: 'epoch-millis',
  },
  /** bigint epoch-ms; column is named `ts`, not `created_at` */
  task_transcripts: {
    ts: 'epoch-millis',
  },
} as const

export type FixtureTimestampEncoding =
  (typeof FIXTURE_TIMESTAMP_ENCODINGS)[keyof typeof FIXTURE_TIMESTAMP_ENCODINGS][keyof (typeof FIXTURE_TIMESTAMP_ENCODINGS)[keyof typeof FIXTURE_TIMESTAMP_ENCODINGS]]
