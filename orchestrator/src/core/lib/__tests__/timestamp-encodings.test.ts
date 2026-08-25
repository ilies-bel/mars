/**
 * Registry exhaustiveness guard for FIXTURE_TIMESTAMP_ENCODINGS.
 *
 * The test asserts the registry matches the authoritative expected set exactly
 * (both directions: registry must contain every entry listed here, and must not
 * contain phantom entries absent from here). When a new table is added to the
 * DDL with epoch-ms timestamp columns:
 *
 *   1. Add it to the EXPECTED constant below.
 *   2. Add it to FIXTURE_TIMESTAMP_ENCODINGS in timestamp-encodings.ts.
 *   3. Update the doc comment in pg-schema.ts.
 *   4. Update both timestamp tables in CLAUDE.md.
 *
 * Failing to do all four causes this test to fail, preventing silent drift.
 */
import { describe, it, expect } from 'vitest'
import { FIXTURE_TIMESTAMP_ENCODINGS } from '../timestamp-encodings.js'

/**
 * Authoritative map of every table in the canonical schema that carries an
 * epoch-millisecond `bigint` timestamp column, plus `tasks` which uses
 * `timestamptz` (`iso-8601`). The full list of tables is in SCHEMA_TABLES in
 * pg-schema.ts; only those with temporal columns that require the caller to
 * choose a SQL display expression appear here.
 *
 * Column names that are NOT intuitive (e.g. `raised_at` instead of
 * `created_at`, `ts` instead of `timestamp`) are intentional — they mirror
 * the actual DDL to catch name-mismatch errors at the query level too.
 */
const EXPECTED = {
  /** timestamptz — to_char(created_at, 'MM-DD HH24:MI') */
  tasks: {
    created_at: 'iso-8601',
    updated_at: 'iso-8601',
  },
  /**
   * bigint epoch-ms — to_char(to_timestamp(created_at / 1000.0), 'MM-DD HH24:MI')
   *
   * Using the tasks pattern (to_char(updated_at,'HH24:MI:SS')) on proposals
   * gives ERROR: cannot use "S" and "PL"/"MI"/"SG"/"PR" together — a
   * misleading error whose real cause is passing a bigint as a timestamp.
   */
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
} satisfies Record<string, Record<string, string>>

describe('FIXTURE_TIMESTAMP_ENCODINGS', () => {
  it('matches the authoritative expected set exactly — no missing, no phantom entries', () => {
    // toStrictEqual checks both directions: every entry in EXPECTED must be in
    // the registry, and every entry in the registry must be in EXPECTED.
    // A mismatch means either the registry was updated without updating this
    // test, or the test was updated without updating the registry.
    expect(FIXTURE_TIMESTAMP_ENCODINGS).toStrictEqual(EXPECTED)
  })

  it('proposals uses epoch-millis for both created_at and updated_at', () => {
    // Targeted assertion for the specific bug: proposals.updated_at is bigint
    // epoch-ms, NOT timestamptz. Using to_char(updated_at,'HH24:MI:SS') gives
    // a misleading format-mask error rather than a clear type error.
    expect(FIXTURE_TIMESTAMP_ENCODINGS.proposals.created_at).toBe('epoch-millis')
    expect(FIXTURE_TIMESTAMP_ENCODINGS.proposals.updated_at).toBe('epoch-millis')
  })

  it('tasks uses iso-8601 (timestamptz), distinct from the epoch-millis tables', () => {
    // Guard against accidentally changing tasks to epoch-millis: that would
    // break every fixture that seeds tasks with ISO-8601 strings.
    expect(FIXTURE_TIMESTAMP_ENCODINGS.tasks.created_at).toBe('iso-8601')
    expect(FIXTURE_TIMESTAMP_ENCODINGS.tasks.updated_at).toBe('iso-8601')
  })
})
