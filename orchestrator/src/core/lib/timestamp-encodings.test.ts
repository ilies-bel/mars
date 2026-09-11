/**
 * Exhaustiveness tests for FIXTURE_TIMESTAMP_ENCODINGS.
 *
 * When you add a new table to pg-schema.ts that has bigint or timestamptz
 * columns, you MUST:
 *   1. Add the table+columns to FIXTURE_TIMESTAMP_ENCODINGS in
 *      timestamp-encodings.ts with the correct encoding ('iso-8601' or
 *      'epoch-millis').
 *   2. Add the table name to TABLES_WITH_TIMESTAMP_COLUMNS below.
 *   3. Update the doc comment in pg-schema.ts and CLAUDE.md if the table is
 *      one an operator is likely to query directly.
 *
 * The test below will fail with a clear list of missing entries if either
 * registry drifts from the other.
 */
import { describe, it, expect } from 'vitest'
import { FIXTURE_TIMESTAMP_ENCODINGS } from './timestamp-encodings.js'

/**
 * Every table in the canonical schema that has at least one column of type
 * `timestamptz` or `bigint` epoch-milliseconds. Text-typed date columns
 * (e.g. learned_recipes.learned_at, health_silences.silenced_at,
 * kpi_snapshots.taken_at) are deliberately excluded — they do not use either
 * of the two supported encodings and cannot be displayed with the standard
 * expressions.
 *
 * Add a table name here when you add a new table with real timestamp columns.
 * The test below fails with a diff if any table listed here is absent from
 * the registry.
 */
const TABLES_WITH_TIMESTAMP_COLUMNS = new Set<string>([
  // timestamptz (iso-8601) tables
  'tasks',
  'merge_jobs',
  'task_deployments',
  'task_terminal_reopens',
  'arc_rescue_attempts',
  'candidate_lessons',
  'steward_ledger',
  'failure_signature_streak',
  'signature_storm_events',
  'dispatch_spend_control',
  'purged_tasks_archive',
  'workflow_patch_proposals',
  'usage_snapshots',
  'mcp_worker_audit',
  'deferrals',
  'main_thread_entries',
  'archive_entries',
  'daemon_heartbeat',
  'domain_flows',
  'chat_thread_tasks',
  // bigint epoch-millis tables
  'proposals',
  'chat_threads',
  'task_blockers',
  'task_proposal_blockers',
  'task_acceptance',
  'action_queue_items',
  'action_queue_history',
  'self_heal_attempts',
  'trace_events',
  'events',
  'task_transcripts',
  'task_durable_transcripts',
  'chat_messages',
  'chat_feedback',
  'conversation_pending_messages',
  'conversation_notice_batches',
  'diagnoses_root_cause',
  'diagnoses_inconclusive',
  'gate_enrichment',
  'gate_burn_in',
  'verify_gates',
  'verify_gate_failure_streaks',
  'gate_fix_proposals',
  'scorers',
  'scorer_results',
  'workflow_configs',
  'tool_promotion_attempts',
  'workflow_runs',
  'workflow_step_runs',
  'promotion_ledger',
  'auto_recipe_runs',
  'questions',
  'task_progress',
  'subscriber_processed_events',
  'subscriber_stalls',
  'signals',
  'notice_dismissals',
  'chat_memory_windows',
  'presence_transitions',
  'cards',
  'failure_reflection_signatures',
  'proposal_notes',
])

describe('FIXTURE_TIMESTAMP_ENCODINGS', () => {
  it('covers every table known to have timestamp columns', () => {
    const registered = new Set(Object.keys(FIXTURE_TIMESTAMP_ENCODINGS))
    const missing = [...TABLES_WITH_TIMESTAMP_COLUMNS].filter(t => !registered.has(t))
    expect(missing, 'Add these tables to FIXTURE_TIMESTAMP_ENCODINGS in timestamp-encodings.ts').toEqual([])
  })

  it('contains no table that is absent from TABLES_WITH_TIMESTAMP_COLUMNS', () => {
    // Orphaned entries in the registry that nobody knows about are almost as
    // dangerous as missing entries — they silently carry stale info.
    const registered = Object.keys(FIXTURE_TIMESTAMP_ENCODINGS)
    const orphaned = registered.filter(t => !TABLES_WITH_TIMESTAMP_COLUMNS.has(t))
    expect(orphaned, 'Remove or add these tables to TABLES_WITH_TIMESTAMP_COLUMNS').toEqual([])
  })

  it('every column encoding value is a recognised encoding type', () => {
    const validEncodings = new Set(['iso-8601', 'epoch-millis'])
    for (const [table, columns] of Object.entries(FIXTURE_TIMESTAMP_ENCODINGS)) {
      for (const [col, enc] of Object.entries(columns)) {
        expect(
          validEncodings.has(enc as string),
          `${table}.${col} has unknown encoding "${enc as string}"`,
        ).toBe(true)
      }
    }
  })

  it('merge_jobs uses iso-8601 (timestamptz) for all its timestamp columns', () => {
    const { merge_jobs } = FIXTURE_TIMESTAMP_ENCODINGS
    expect(merge_jobs.created_at).toBe('iso-8601')
    expect(merge_jobs.updated_at).toBe('iso-8601')
    expect(merge_jobs.claimed_at).toBe('iso-8601')
    expect(merge_jobs.started_at).toBe('iso-8601')
    expect(merge_jobs.finished_at).toBe('iso-8601')
  })

  it('proposals uses epoch-millis (bigint) for all its timestamp columns', () => {
    const { proposals } = FIXTURE_TIMESTAMP_ENCODINGS
    expect(proposals.created_at).toBe('epoch-millis')
    expect(proposals.updated_at).toBe('epoch-millis')
  })

  it('tasks uses iso-8601 (timestamptz) for created_at and updated_at', () => {
    const { tasks } = FIXTURE_TIMESTAMP_ENCODINGS
    expect(tasks.created_at).toBe('iso-8601')
    expect(tasks.updated_at).toBe('iso-8601')
  })
})
