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
 * timestamp-encodings.test.ts will fail if this registry drifts from the
 * hardcoded list of tables-with-timestamps maintained there.
 *
 * ── Encoding quick reference ─────────────────────────────────────────────────
 *
 * iso-8601 (timestamptz) tables — display with: to_char(col, 'MM-DD HH24:MI')
 *   tasks, merge_jobs, task_deployments, task_terminal_reopens, arc_rescue_attempts,
 *   candidate_lessons, steward_ledger, failure_signature_streak, signature_storm_events,
 *   dispatch_spend_control, purged_tasks_archive, workflow_patch_proposals,
 *   usage_snapshots, mcp_worker_audit, deferrals, main_thread_entries,
 *   archive_entries, daemon_heartbeat, domain_flows, chat_thread_tasks
 *
 * epoch-millis (bigint) tables — display with: to_char(to_timestamp(col / 1000.0), 'MM-DD HH24:MI')
 *   proposals, chat_threads, task_blockers, task_proposal_blockers, task_acceptance,
 *   action_queue_items, action_queue_history, self_heal_attempts, trace_events,
 *   events, task_transcripts, task_durable_transcripts, chat_messages, chat_feedback,
 *   conversation_pending_messages, conversation_notice_batches, diagnoses_root_cause,
 *   diagnoses_inconclusive, gate_enrichment, gate_burn_in, verify_gates,
 *   verify_gate_failure_streaks, gate_fix_proposals, scorers, scorer_results,
 *   workflow_configs, tool_promotion_attempts, workflow_runs, workflow_step_runs,
 *   promotion_ledger, auto_recipe_runs, questions, task_progress,
 *   subscriber_processed_events, subscriber_stalls, signals, notice_dismissals,
 *   chat_memory_windows, presence_transitions, cards, failure_reflection_signatures,
 *   proposal_notes
 */
export const FIXTURE_TIMESTAMP_ENCODINGS = {
  // ── timestamptz (iso-8601) ────────────────────────────────────────────────

  /** timestamptz — to_char(created_at, 'MM-DD HH24:MI') */
  tasks: {
    leased_at: 'iso-8601',
    created_at: 'iso-8601',
    updated_at: 'iso-8601',
  },
  /** timestamptz — claimed_at/started_at/finished_at are nullable; all iso-8601 */
  merge_jobs: {
    claimed_at: 'iso-8601',
    started_at: 'iso-8601',
    finished_at: 'iso-8601',
    created_at: 'iso-8601',
    updated_at: 'iso-8601',
  },
  /** timestamptz — torn_down_at is nullable */
  task_deployments: {
    created_at: 'iso-8601',
    updated_at: 'iso-8601',
    torn_down_at: 'iso-8601',
  },
  /** timestamptz — consumed_at is nullable */
  task_terminal_reopens: {
    reopened_at: 'iso-8601',
    consumed_at: 'iso-8601',
  },
  /** timestamptz */
  arc_rescue_attempts: {
    updated_at: 'iso-8601',
  },
  /** timestamptz */
  candidate_lessons: {
    first_seen_at: 'iso-8601',
    last_seen_at: 'iso-8601',
  },
  /** timestamptz; column is named `ts` not `created_at` */
  steward_ledger: {
    ts: 'iso-8601',
  },
  /** timestamptz */
  failure_signature_streak: {
    updated_at: 'iso-8601',
  },
  /** timestamptz */
  signature_storm_events: {
    recorded_at: 'iso-8601',
  },
  /** timestamptz */
  dispatch_spend_control: {
    updated_at: 'iso-8601',
  },
  /** timestamptz */
  purged_tasks_archive: {
    purged_at: 'iso-8601',
  },
  /** timestamptz */
  workflow_patch_proposals: {
    created_at: 'iso-8601',
  },
  /** timestamptz; column is named `captured_at` */
  usage_snapshots: {
    captured_at: 'iso-8601',
  },
  /** timestamptz */
  mcp_worker_audit: {
    created_at: 'iso-8601',
  },
  /** timestamptz; target_window_end is nullable */
  deferrals: {
    deferred_at: 'iso-8601',
    target_window_end: 'iso-8601',
  },
  /** timestamptz */
  main_thread_entries: {
    created_at: 'iso-8601',
  },
  /** timestamptz */
  archive_entries: {
    occurred_at: 'iso-8601',
  },
  /** timestamptz; columns are boot_ts and last_beat_ts */
  daemon_heartbeat: {
    boot_ts: 'iso-8601',
    last_beat_ts: 'iso-8601',
  },
  /** timestamptz; frozen_at is nullable */
  domain_flows: {
    frozen_at: 'iso-8601',
    created_at: 'iso-8601',
    updated_at: 'iso-8601',
  },
  /** timestamptz */
  chat_thread_tasks: {
    created_at: 'iso-8601',
  },

  // ── bigint epoch-millis ────────────────────────────────────────────────────

  /**
   * bigint epoch-ms — to_char(to_timestamp(created_at / 1000.0), 'MM-DD HH24:MI')
   * Note: last_slice_failed_at is nullable.
   */
  proposals: {
    created_at: 'epoch-millis',
    updated_at: 'epoch-millis',
    last_slice_failed_at: 'epoch-millis',
  },
  /**
   * bigint epoch-ms; archived_at / closed_at / relevance_scored_at are nullable.
   */
  chat_threads: {
    archived_at: 'epoch-millis',
    closed_at: 'epoch-millis',
    created_at: 'epoch-millis',
    updated_at: 'epoch-millis',
    relevance_scored_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  task_blockers: {
    created_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  task_proposal_blockers: {
    created_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  task_acceptance: {
    updated_at: 'epoch-millis',
  },
  /**
   * bigint epoch-ms; creation column is raised_at (not created_at);
   * lifecycle column is status (not state).
   * resolved_at / last_seen_at / snoozed_until are nullable.
   */
  action_queue_items: {
    raised_at: 'epoch-millis',
    resolved_at: 'epoch-millis',
    last_seen_at: 'epoch-millis',
    snoozed_until: 'epoch-millis',
  },
  /** bigint epoch-ms; column is named `at` */
  action_queue_history: {
    at: 'epoch-millis',
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
  /** bigint epoch-ms */
  task_durable_transcripts: {
    created_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  chat_messages: {
    created_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  chat_feedback: {
    created_at: 'epoch-millis',
    updated_at: 'epoch-millis',
  },
  /** bigint epoch-ms; delivered_at is nullable */
  conversation_pending_messages: {
    created_at: 'epoch-millis',
    delivered_at: 'epoch-millis',
  },
  /** bigint epoch-ms; flushed_at is nullable */
  conversation_notice_batches: {
    opened_at: 'epoch-millis',
    flushed_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  diagnoses_root_cause: {
    recorded_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  diagnoses_inconclusive: {
    recorded_at: 'epoch-millis',
  },
  /** bigint epoch-ms; approved_at / retired_at are nullable */
  gate_enrichment: {
    created_at: 'epoch-millis',
    updated_at: 'epoch-millis',
    approved_at: 'epoch-millis',
    retired_at: 'epoch-millis',
  },
  /** bigint epoch-ms; promoted_at is nullable */
  gate_burn_in: {
    promoted_at: 'epoch-millis',
  },
  /** bigint epoch-ms; quarantined_at / last_failure_at / last_pass_at are nullable */
  verify_gates: {
    created_at: 'epoch-millis',
    quarantined_at: 'epoch-millis',
    last_failure_at: 'epoch-millis',
    last_pass_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  verify_gate_failure_streaks: {
    updated_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  gate_fix_proposals: {
    created_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  scorers: {
    created_at: 'epoch-millis',
    updated_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  scorer_results: {
    created_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  workflow_configs: {
    created_at: 'epoch-millis',
    updated_at: 'epoch-millis',
  },
  /** bigint epoch-ms; decided_at is nullable */
  tool_promotion_attempts: {
    created_at: 'epoch-millis',
    decided_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  workflow_runs: {
    created_at: 'epoch-millis',
    updated_at: 'epoch-millis',
  },
  /** bigint epoch-ms; finished_at is nullable */
  workflow_step_runs: {
    started_at: 'epoch-millis',
    finished_at: 'epoch-millis',
  },
  /** bigint epoch-ms; decided_at is nullable */
  promotion_ledger: {
    created_at: 'epoch-millis',
    decided_at: 'epoch-millis',
  },
  /** bigint epoch-ms; outcome_recorded_at is nullable */
  auto_recipe_runs: {
    outcome_recorded_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  questions: {
    created_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  task_progress: {
    created_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  subscriber_processed_events: {
    processed_at: 'epoch-millis',
  },
  /** bigint epoch-ms; column is named `raised_at` */
  subscriber_stalls: {
    raised_at: 'epoch-millis',
  },
  /** bigint epoch-ms; column is named `recorded_at` */
  signals: {
    recorded_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  notice_dismissals: {
    dismissed_at: 'epoch-millis',
  },
  /** bigint epoch-ms; both columns are nullable */
  chat_memory_windows: {
    last_used_at: 'epoch-millis',
    cut_at: 'epoch-millis',
  },
  /**
   * bigint epoch-ms; from_ms / to_ms are wall-clock millisecond timestamps
   * (the bounding pings of an away span), not durations. recorded_at is also
   * epoch-ms.
   */
  presence_transitions: {
    from_ms: 'epoch-millis',
    to_ms: 'epoch-millis',
    recorded_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  cards: {
    created_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  failure_reflection_signatures: {
    first_seen_at: 'epoch-millis',
    last_seen_at: 'epoch-millis',
  },
  /** bigint epoch-ms */
  proposal_notes: {
    created_at: 'epoch-millis',
  },
} as const

export type FixtureTimestampEncoding =
  (typeof FIXTURE_TIMESTAMP_ENCODINGS)[keyof typeof FIXTURE_TIMESTAMP_ENCODINGS][keyof (typeof FIXTURE_TIMESTAMP_ENCODINGS)[keyof typeof FIXTURE_TIMESTAMP_ENCODINGS]]
