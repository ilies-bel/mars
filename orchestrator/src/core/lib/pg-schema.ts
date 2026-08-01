/**
 * THE canonical Mars schema (migration 0002 §4) — every table, index, CHECK
 * and FK in one place. Replaces the SQLite-era imperative migration engine
 * (queue.ts `migrateQueueSchema` + per-module `init*` DDL) wholesale: Mars is
 * pre-1.0, the in-place migration history is captured once by the one-time
 * SQLite importer (`src/init/import-sqlite.ts`), and from here on the schema
 * evolves through this module + `schema_migrations`.
 *
 * Type translation from the SQLite inventory (design 0002 §4):
 * - `INTEGER PRIMARY KEY AUTOINCREMENT` → `bigint GENERATED ALWAYS AS
 *   IDENTITY` (events / self_heal_attempts; outbox cursor monotonicity is
 *   preserved by the sequence).
 * - every other `INTEGER` → `bigint` (epoch-millis columns exceed int4;
 *   uniform int8 keeps the wrapper's one type parser sufficient). 0/1 flag
 *   columns stay integers — retyping to boolean is out of scope.
 * - `REAL` → `double precision`, `BLOB` → `bytea`.
 * - `DEFAULT (unixepoch())` → `DEFAULT floor(extract(epoch from now()))::bigint`.
 * - JSON-in-TEXT columns stay `text`; epoch-millisecond operational timestamps use `bigint`.
 *
 * Conflicts resolved here, once:
 * - `tool_promotion_attempts` uses the store version
 *   (store/tool-promotion-store.ts): status proposed/benchmarked/promoted/
 *   retired, benchmark_before/benchmark_after, bigint created_at/decided_at.
 *   The queue.ts stub shape is dead.
 * - `proposals` is the full proposals.ts shape (bigint epoch timestamps),
 *   superseding the queue.ts FK stub.
 * - `task_blockers` keeps `provenance` (the SQLite CHECK-rebuild dropped it —
 *   a latent bug, not a decision).
 * - trace_events / task_transcripts / task_durable_transcripts exist exactly
 *   once (they were duplicated across 4/2/3 files).
 * - `idx_events_id` (redundant with the PK) is not ported.
 * - `self_heal_attempts.fix_task_id` gains an index: it carries ON DELETE
 *   CASCADE from tasks and would seq-scan on every task purge otherwise
 *   (flagged as a real gap by the migration inventory).
 */

import type { DbClient } from './db.js'
import { __execSchemaBatch } from './db.js'

/** Bumped when the canonical DDL changes shape. */
export const SCHEMA_VERSION = '0016'

/** Current epoch time in milliseconds for bigint operational timestamps. */
const EPOCH_NOW = "floor(extract(epoch from now()) * 1000)::bigint"

/**
 * The complete DDL, in dependency order (FK targets first). Every statement
 * is idempotent (IF NOT EXISTS) so ensureSchema can run at every startup.
 */
const DDL: readonly string[] = [
  // ── schema versioning ─────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    applied_at text NOT NULL
  )`,

  // ── proposal domain (FK target of tasks) ──────────────────────────────────
  `CREATE TABLE IF NOT EXISTS proposals (
    id                text PRIMARY KEY,
    title             text NOT NULL DEFAULT '',
    problem           text NOT NULL DEFAULT '',
    solution          text NOT NULL DEFAULT '',
    out_of_scope      text NOT NULL DEFAULT '',
    notes             text NOT NULL DEFAULT '',
    status            text NOT NULL DEFAULT 'draft',
    source            text NOT NULL DEFAULT 'human',
    author_kind       text,
    author_name       text,
    kpi_tag           text,
    fingerprint       text,
    origin_session_id text,
    coordinated       boolean NOT NULL DEFAULT false,
    created_at        bigint NOT NULL,
    updated_at        bigint NOT NULL
  )`,
  // Proposal dismissal has always stored this terminal state. Normalize the
  // short-lived, incompatible `rejected` value before proposal readers apply
  // the closed lifecycle type.
  `UPDATE proposals SET status = 'dismissed' WHERE status = 'rejected'`,
  `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS coordinated boolean NOT NULL DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS idx_proposals_fingerprint
     ON proposals(fingerprint) WHERE fingerprint IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS proposal_user_stories (
    proposal_id text   NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    position    bigint NOT NULL,
    text        text   NOT NULL,
    PRIMARY KEY (proposal_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS proposal_dependencies (
    proposal_id         text NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    blocker_proposal_id text NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    created_at          text NOT NULL,
    PRIMARY KEY (proposal_id, blocker_proposal_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_proposal_dependencies_proposal
     ON proposal_dependencies(proposal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_proposal_dependencies_blocker
     ON proposal_dependencies(blocker_proposal_id)`,
  `CREATE TABLE IF NOT EXISTS proposal_notes (
    id         text   PRIMARY KEY,
    slug       text   NOT NULL,
    text       text   NOT NULL,
    created_at bigint NOT NULL
  )`,

  // ── task domain ───────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS tasks (
    id                   text   PRIMARY KEY,
    prompt               text   NOT NULL,
    status               text   NOT NULL
                                CHECK (status IN ('draft','triaging','queued','running','verifying','awaiting-validation','awaiting-human','merging','vega-reconciling','done','failed','dropped','blocked','under_investigation')),
    plan_functional      text,
    plan_technical       text,
    branch               text,
    worktree_path        text,
    claude_session_id    text,
    error                text,
    drop_reason          text,
    retry_count          bigint NOT NULL DEFAULT 0,
    author_kind          text,
    author_name          text,
    failure_reason       text,
    failure_reason_code  text,
    stall_diagnostics    text,
    -- Quoted: DEFERRABLE is a reserved PostgreSQL keyword, so an unquoted
    -- column definition is a syntax error. Reads stay unquoted (t.deferrable)
    -- because a qualified reference parses fine.
    "deferrable"         bigint NOT NULL DEFAULT 0,
    recovery_payload     text,
    fix_for_task_id      text   REFERENCES tasks(id),
    failure_signature    text,
    kind                 text,
    priority             bigint NOT NULL DEFAULT 0,
    tag                  text,
    tags_json            text,
    origin_id            text,
    parent_proposal_id   text   REFERENCES proposals(id),
    slice_index          bigint,
    failed_phase         text,
    resume_from          text,
    verify_cmd           text,
    dev_server_url       text,
    dev_server_pid       bigint,
    preview_validated    bigint NOT NULL DEFAULT 0,
    task_type            text,
    read_first_json      text,
    prescriptive_action  text,
    slice_kind           text,
    sub_deliverable_json text,
    integration_head_sha text,
    followup_dedup_key   text,
    intent               text   NOT NULL DEFAULT '',
    lease_owner          text,
    leased_at            timestamptz,
    lease_note           text,
    origin_session_id    text,
    workflow             text,
    current_step_name    text,
    current_step_guide   text,
    activity_detail      text,
    review_packet_json   text,
    env_restart_count    bigint NOT NULL DEFAULT 0,
    requeue_anchor_ms    bigint,
    requeue_dispatch_uptime_ms bigint,
    created_at           timestamptz NOT NULL,
    updated_at           timestamptz NOT NULL
  )`,
  // Hard-cut existing installations from ISO-8601 text to native timestamps.
  // The explicit USING clause intentionally rejects malformed legacy values
  // instead of retaining a text compatibility path.
  `ALTER TABLE tasks
     ALTER COLUMN leased_at TYPE timestamptz USING leased_at::timestamptz,
     ALTER COLUMN created_at TYPE timestamptz USING created_at::timestamptz,
     ALTER COLUMN updated_at TYPE timestamptz USING updated_at::timestamptz`,
  // Backfill `requeue_anchor_ms` for databases created before this column was
  // added. IF NOT EXISTS makes this idempotent on fresh databases (where the
  // column already exists from the CREATE TABLE above).
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS requeue_anchor_ms bigint`,
  // Snapshot of the daemon's cumulative dispatch uptime when this re-queue
  // episode first dispatched. This lets the ceiling exclude pauses and daemon
  // downtime without refunding previously accumulated progress time.
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS requeue_dispatch_uptime_ms bigint`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stall_diagnostics jsonb`,
  // Terminal task states are absorbing.  The application preflights this
  // invariant for a typed error, while this trigger protects every other SQL
  // writer (including future code paths and operational scripts).
  `CREATE TABLE IF NOT EXISTS task_terminal_reopens (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id     text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    reason      text NOT NULL,
    reopened_by text NOT NULL,
    reopened_at timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz
  )`,
  `CREATE OR REPLACE FUNCTION reject_terminal_task_transition()
   RETURNS trigger AS $$
   BEGIN
     IF OLD.status IN ('done', 'failed', 'dropped')
        AND NEW.status IS DISTINCT FROM OLD.status
        AND NOT EXISTS (
          SELECT 1 FROM task_terminal_reopens
          WHERE task_id = OLD.id AND consumed_at IS NULL
        ) THEN
       RAISE EXCEPTION 'terminal task % cannot transition from % to %', OLD.id, OLD.status, NEW.status
         USING ERRCODE = 'P0001';
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS tasks_reject_terminal_transition ON tasks`,
  `CREATE TRIGGER tasks_reject_terminal_transition
     BEFORE UPDATE OF status ON tasks
     FOR EACH ROW EXECUTE FUNCTION reject_terminal_task_transition()`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_priority_created
     ON tasks(priority DESC, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_fix_for
     ON tasks(fix_for_task_id, failure_signature)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_origin_id ON tasks(origin_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_parent_proposal_id
     ON tasks(parent_proposal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_followup_dedup_key
     ON tasks(followup_dedup_key)`,
  `CREATE TABLE IF NOT EXISTS task_blockers (
    task_id         text NOT NULL REFERENCES tasks(id),
    blocker_task_id text NOT NULL REFERENCES tasks(id),
    state           text NOT NULL DEFAULT 'confirmed'
                         CHECK (state IN ('confirmed','pending-review','rejected')),
    provenance      text NOT NULL DEFAULT 'inferred',
    created_at      bigint NOT NULL,
    PRIMARY KEY (task_id, blocker_task_id)
  )`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'task_blockers'
          AND column_name = 'created_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE task_blockers
         ALTER COLUMN created_at TYPE bigint
         USING (EXTRACT(EPOCH FROM created_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `CREATE INDEX IF NOT EXISTS idx_task_blockers_task ON task_blockers(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_blockers_blocker
     ON task_blockers(blocker_task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_blockers_task_state
     ON task_blockers(task_id, state)`,
  `CREATE TABLE IF NOT EXISTS task_proposal_blockers (
    task_id     text NOT NULL REFERENCES tasks(id),
    proposal_id text NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    created_at  bigint NOT NULL,
    PRIMARY KEY (task_id, proposal_id)
  )`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'task_proposal_blockers'
          AND column_name = 'created_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE task_proposal_blockers
         ALTER COLUMN created_at TYPE bigint
         USING (EXTRACT(EPOCH FROM created_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `CREATE INDEX IF NOT EXISTS idx_task_proposal_blockers_task
     ON task_proposal_blockers(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_task_proposal_blockers_proposal
     ON task_proposal_blockers(proposal_id)`,
  `CREATE TABLE IF NOT EXISTS task_acceptance (
    id         text   PRIMARY KEY,
    task_id    text   NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    position   bigint NOT NULL,
    text       text   NOT NULL,
    status     text   NOT NULL DEFAULT 'pending',
    note       text,
    updated_at bigint NOT NULL,
    UNIQUE (task_id, position)
  )`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'task_acceptance'
          AND column_name = 'updated_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE task_acceptance
         ALTER COLUMN updated_at TYPE bigint
         USING (EXTRACT(EPOCH FROM updated_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `CREATE INDEX IF NOT EXISTS idx_task_acceptance_task ON task_acceptance(task_id)`,
  `CREATE TABLE IF NOT EXISTS self_heal_attempts (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_task_id    text NOT NULL,
    failure_signature text NOT NULL,
    fix_task_id       text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at        bigint NOT NULL
  )`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'self_heal_attempts'
          AND column_name = 'created_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE self_heal_attempts
         ALTER COLUMN created_at TYPE bigint
         USING (EXTRACT(EPOCH FROM created_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `CREATE INDEX IF NOT EXISTS idx_self_heal_attempts_parent_signature
     ON self_heal_attempts(parent_task_id, failure_signature)`,
  `CREATE INDEX IF NOT EXISTS idx_self_heal_attempts_fix_task
     ON self_heal_attempts(fix_task_id)`,
  // Slice 3 of PRD d7835017: per-(task_id, failure_signature) non-code requeue ledger.
  // Separate table avoids modifying the NOT NULL + FK constraint on
  // self_heal_attempts.fix_task_id, which is incompatible with nullable entries.
  // self_heal_attempts remains unchanged; non-code re-queues live here only.
  `CREATE TABLE IF NOT EXISTS non_code_requeue_attempts (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id           text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    failure_signature text NOT NULL,
    created_at        text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_non_code_requeue_attempts_task
     ON non_code_requeue_attempts(task_id, failure_signature)`,
  `CREATE TABLE IF NOT EXISTS task_claude_sessions (
    task_id    text   NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    session_id text   NOT NULL,
    position   bigint NOT NULL,
    PRIMARY KEY (task_id, session_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_claude_sessions_task
     ON task_claude_sessions(task_id, position)`,
  `CREATE TABLE IF NOT EXISTS task_spec_files (
    task_id  text   NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    path     text   NOT NULL,
    position bigint NOT NULL,
    PRIMARY KEY (task_id, path)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_spec_files_task
     ON task_spec_files(task_id, position)`,
  `CREATE TABLE IF NOT EXISTS task_done_criteria (
    task_id   text   NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    criterion text   NOT NULL,
    position  bigint NOT NULL,
    PRIMARY KEY (task_id, criterion)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_done_criteria_task
     ON task_done_criteria(task_id, position)`,
  `CREATE TABLE IF NOT EXISTS questions (
    id         text PRIMARY KEY,
    task_id    text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    question   text NOT NULL,
    rationale  text,
    category   text,
    answer     text,
    status     text NOT NULL DEFAULT 'open',
    created_at bigint NOT NULL
  )`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'questions'
          AND column_name = 'created_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE questions
         ALTER COLUMN created_at TYPE bigint
         USING (EXTRACT(EPOCH FROM created_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `CREATE INDEX IF NOT EXISTS idx_questions_task ON questions(task_id)`,
  `CREATE TABLE IF NOT EXISTS task_progress (
    id              text   PRIMARY KEY,
    task_id         text   NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at      bigint NOT NULL,
    author          text   NOT NULL,
    kind            text   NOT NULL CHECK (kind IN ('note','check','uncheck')),
    body            text   NOT NULL,
    criterion_index bigint
  )`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'task_progress'
          AND column_name = 'created_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE task_progress
         ALTER COLUMN created_at TYPE bigint
         USING (EXTRACT(EPOCH FROM created_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `CREATE INDEX IF NOT EXISTS idx_task_progress_task_time
     ON task_progress(task_id, created_at)`,

  // ── observability (no FK to tasks on purpose: events outlive tasks) ───────
  `CREATE TABLE IF NOT EXISTS trace_events (
    id        text PRIMARY KEY,
    timestamp bigint NOT NULL,
    kind      text NOT NULL,
    severity  text NOT NULL DEFAULT 'info',
    task_id   text,
    origin_id text,
    phase     text,
    payload   text NOT NULL DEFAULT '{}'
  )`,
  // Older installations stored ISO-8601 text. Guard the conversion so fresh
  // bigint tables remain a no-op while existing indexes are rebuilt against
  // the numeric column type by PostgreSQL.
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'trace_events'
          AND column_name = 'timestamp'
          AND data_type = 'text'
     ) THEN
       ALTER TABLE trace_events
         ALTER COLUMN timestamp TYPE bigint
         USING (EXTRACT(EPOCH FROM timestamp::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `CREATE INDEX IF NOT EXISTS idx_trace_events_task_time
     ON trace_events (task_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_trace_events_time_desc
     ON trace_events (timestamp DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_trace_events_origin_time
     ON trace_events (origin_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_trace_events_step_ended_time
     ON trace_events (timestamp) WHERE kind = 'step_ended'`,
  `CREATE TABLE IF NOT EXISTS task_transcripts (
    task_id    text   NOT NULL,
    session_id text   NOT NULL,
    seq        bigint NOT NULL,
    chunk      text   NOT NULL,
    ts         bigint NOT NULL,
    PRIMARY KEY (task_id, session_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_transcripts_task
     ON task_transcripts (task_id, ts)`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'task_transcripts'
          AND column_name = 'ts' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE task_transcripts
         ALTER COLUMN ts TYPE bigint
         USING (EXTRACT(EPOCH FROM ts::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `CREATE TABLE IF NOT EXISTS task_durable_transcripts (
    task_id    text   PRIMARY KEY,
    session_id text   NOT NULL DEFAULT '',
    step_name  text   NOT NULL DEFAULT '',
    created_at bigint NOT NULL,
    transcript bytea  NOT NULL,
    byte_len   bigint NOT NULL
  )`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'task_durable_transcripts'
          AND column_name = 'created_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE task_durable_transcripts
         ALTER COLUMN created_at TYPE bigint
         USING (EXTRACT(EPOCH FROM created_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,

  // ── outbox / wire bus ─────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS events (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type    text   NOT NULL,
    payload text   NOT NULL,
    ts      bigint NOT NULL DEFAULT ${EPOCH_NOW}
  )`,
  `CREATE TABLE IF NOT EXISTS subscribers (
    name   text   PRIMARY KEY,
    cursor bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS subscriber_processed_events (
    subscriber_id text   NOT NULL,
    event_id      bigint NOT NULL,
    processed_at  bigint NOT NULL DEFAULT ${EPOCH_NOW},
    PRIMARY KEY (subscriber_id, event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS subscriber_stalls (
    subscriber_id text   NOT NULL,
    event_id      bigint NOT NULL,
    last_error    text   NOT NULL,
    raised_at     bigint NOT NULL DEFAULT ${EPOCH_NOW},
    PRIMARY KEY (subscriber_id, event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS signals (
    id          text   PRIMARY KEY,
    task_id     text   NOT NULL,
    kind        text   NOT NULL,
    recorded_at bigint NOT NULL DEFAULT ${EPOCH_NOW}
  )`,

  // ── action queue ──────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS action_queue_items (
    id              text   PRIMARY KEY,
    kind            text   NOT NULL,
    category        text   NOT NULL,
    priority        text   NOT NULL,
    state           text   NOT NULL DEFAULT 'open',
    title           text   NOT NULL,
    body            text   NOT NULL DEFAULT '',
    payload         text   NOT NULL DEFAULT '{}',
    context         text   NOT NULL DEFAULT '{}',
    raised_by       text   NOT NULL,
    raised_at       bigint NOT NULL DEFAULT ${EPOCH_NOW},
    resolved_at     bigint,
    resolution      text,
    resolution_note text,
    root_cause      text,
    fingerprint     text,
    signature       text,
    seen_count      bigint NOT NULL DEFAULT 1,
    last_seen_at    bigint,
    resolved_by     text,
    origin_task_id  text,
    snoozed_until   bigint
  )`,
  // Existing installations may have either the original text columns or the
  // interim timestamptz form. Convert both to epoch milliseconds; fresh bigint
  // columns are intentionally skipped so this remains safe at every startup.
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'action_queue_items'
          AND column_name = 'raised_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE action_queue_items
         ALTER COLUMN raised_at TYPE bigint
         USING (EXTRACT(EPOCH FROM raised_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'action_queue_items'
          AND column_name = 'resolved_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE action_queue_items
         ALTER COLUMN resolved_at TYPE bigint
         USING (EXTRACT(EPOCH FROM resolved_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'action_queue_items'
          AND column_name = 'last_seen_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE action_queue_items
         ALTER COLUMN last_seen_at TYPE bigint
         USING (EXTRACT(EPOCH FROM last_seen_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'action_queue_items'
          AND column_name = 'snoozed_until' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE action_queue_items
         ALTER COLUMN snoozed_until TYPE bigint
         USING (EXTRACT(EPOCH FROM snoozed_until::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `ALTER TABLE action_queue_items
     ALTER COLUMN raised_at SET DEFAULT ${EPOCH_NOW}`,
  `CREATE INDEX IF NOT EXISTS idx_action_queue_fingerprint_state
     ON action_queue_items(fingerprint, state)`,
  `CREATE INDEX IF NOT EXISTS idx_action_queue_state ON action_queue_items(state)`,
  `CREATE INDEX IF NOT EXISTS idx_action_queue_open_snoozed_until
     ON action_queue_items(snoozed_until, raised_at DESC) WHERE state = 'open'`,
  // "by" is a reserved word in PostgreSQL — quoted here, and call sites must
  // quote it too (all-lowercase, so quoting does not change identity).
  `CREATE TABLE IF NOT EXISTS action_queue_history (
    id         text PRIMARY KEY,
    item_id    text NOT NULL REFERENCES action_queue_items(id),
    at         bigint NOT NULL,
    from_state text,
    to_state   text NOT NULL,
    "by"       text,
    note       text
  )`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'action_queue_history'
          AND column_name = 'at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE action_queue_history
         ALTER COLUMN at TYPE bigint
         USING (EXTRACT(EPOCH FROM at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `CREATE INDEX IF NOT EXISTS idx_action_queue_history_item
     ON action_queue_history(item_id, at)`,

  // ── chat ──────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS chat_threads (
    id             text   PRIMARY KEY,
    title          text   NOT NULL DEFAULT '',
    status         text   NOT NULL DEFAULT 'idle',
    posture        text   NOT NULL DEFAULT 'triage',
    origin         text,
    alert_item_id  text,
    alert_resolved bigint NOT NULL DEFAULT 0,
    closed_at      bigint,
    terminal_event text,
    terminal_entity_id text,
    created_at     bigint NOT NULL,
    updated_at     bigint NOT NULL
  )`,
  // Idempotent column migrations for already-provisioned databases.
  `ALTER TABLE IF EXISTS tasks ADD COLUMN IF NOT EXISTS qa text NOT NULL DEFAULT 'auto'`,
  `ALTER TABLE IF EXISTS tasks ADD COLUMN IF NOT EXISTS compensates_arc_id text`,
  `ALTER TABLE IF EXISTS tasks ADD COLUMN IF NOT EXISTS activity_detail text`,
  `ALTER TABLE IF EXISTS tasks ADD COLUMN IF NOT EXISTS env_restart_count bigint NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS arc_rescue_attempts (
    origin_id  text PRIMARY KEY,
    attempts   bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Backfill every pre-existing rescue task once. ON CONFLICT deliberately
  // preserves live counter values on later startups: the counter is monotonic.
  `INSERT INTO arc_rescue_attempts (origin_id, attempts)
     SELECT origin_id, COUNT(*)
       FROM tasks
      WHERE origin_id IS NOT NULL
        AND tags_json LIKE '%rescue-operator%'
      GROUP BY origin_id
     ON CONFLICT (origin_id) DO NOTHING`,
  // Rescue counters no longer belong to an origin task row: proposal-slug arcs
  // have no such row. Remove the obsolete per-task storage in the same cut.
  `ALTER TABLE IF EXISTS tasks DROP COLUMN IF EXISTS arc_rescue_attempts`,
  `ALTER TABLE IF EXISTS tasks ADD COLUMN IF NOT EXISTS review_packet_json text`,
  `ALTER TABLE IF EXISTS tasks ADD COLUMN IF NOT EXISTS qa_report_json text`,
  // `stall_diagnostics` and `deferrable` are SELECTed by core/queue.ts but were
  // never added to the canonical DDL, so every already-provisioned database
  // failed `mars daemon status` with "column t.<name> does not exist".
  // `deferrable` is a 0/1 flag (queue.ts reads it as Number(row.deferrable) === 1).
  `ALTER TABLE IF EXISTS tasks ADD COLUMN IF NOT EXISTS stall_diagnostics text`,
  `ALTER TABLE IF EXISTS tasks ADD COLUMN IF NOT EXISTS "deferrable" bigint NOT NULL DEFAULT 0`,
  // `evaporated_at` -> `closed_at`. This block must stay idempotent: the whole
  // DDL batch replays on EVERY daemon boot inside one transaction, so a single
  // failing statement aborts the batch and the daemon can never start again.
  //
  // Three shapes reach this point:
  //   1. Neither column      — impossible after the CREATE TABLE above; no-op.
  //   2. Only `evaporated_at` — legacy database; a plain RENAME preserves the
  //      data, and the type-normalisation block below coerces it to bigint.
  //   3. BOTH columns        — a database that was migrated to `closed_at` and
  //      then had `evaporated_at` re-added by an older daemon binary booting
  //      against it. A bare RENAME raises 42701 `column "closed_at" ...
  //      already exists` here, which is exactly the boot-loop this guard ends.
  //
  // Case 3 heals only where healing is unambiguous, and refuses otherwise:
  //   - `evaporated_at` NULL, or equal to `closed_at`  -> nothing to lose, drop.
  //   - `closed_at` NULL, `evaporated_at` set          -> fold the legacy value
  //     into `closed_at`. Strictly non-destructive.
  //   - both set and DIFFERENT                         -> a genuine conflict.
  //     RAISE, because picking a winner would irreversibly destroy the other
  //     timestamp. On this repo's database that count is 0 (94 rows,
  //     `evaporated_at` entirely NULL), but this DDL also ships to consumer
  //     repos through `mars init` / `mars update`, and a migration that cannot
  //     decide must stop rather than guess. Refusing to boot is recoverable;
  //     a silently discarded column is not.
  // Both columns are normalised to bigint epoch-ms before the comparison so it
  // cannot false-positive on a text/bigint representation mismatch. Nothing in
  // the repo reads `evaporated_at` any more, so the drop is a clean cut.
  `DO $$
   DECLARE
     evap_type   text;
     closed_type text;
     conflicts   bigint;
   BEGIN
     SELECT data_type INTO evap_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'chat_threads'
        AND column_name = 'evaporated_at';
     IF evap_type IS NULL THEN
       RETURN;
     END IF;

     SELECT data_type INTO closed_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'chat_threads'
        AND column_name = 'closed_at';

     IF closed_type IS NULL THEN
       ALTER TABLE chat_threads RENAME COLUMN evaporated_at TO closed_at;
       RETURN;
     END IF;

     IF evap_type <> 'bigint' THEN
       ALTER TABLE chat_threads
         ALTER COLUMN evaporated_at TYPE bigint
         USING (EXTRACT(EPOCH FROM evaporated_at::timestamptz) * 1000)::bigint;
     END IF;
     IF closed_type <> 'bigint' THEN
       ALTER TABLE chat_threads
         ALTER COLUMN closed_at TYPE bigint
         USING (EXTRACT(EPOCH FROM closed_at::timestamptz) * 1000)::bigint;
     END IF;

     EXECUTE 'SELECT count(*) FROM chat_threads
               WHERE evaporated_at IS NOT NULL AND closed_at IS NOT NULL
                 AND evaporated_at <> closed_at'
       INTO conflicts;
     IF conflicts > 0 THEN
       RAISE EXCEPTION
         'chat_threads has % row(s) where the legacy evaporated_at and the canonical closed_at hold different timestamps; refusing to guess which one to keep',
         conflicts
         USING HINT = 'Reconcile the two columns by hand (closed_at is the column every reader uses), then DROP COLUMN evaporated_at, then start the daemon again.';
     END IF;

     EXECUTE 'UPDATE chat_threads SET closed_at = evaporated_at
               WHERE closed_at IS NULL AND evaporated_at IS NOT NULL';
     ALTER TABLE chat_threads DROP COLUMN evaporated_at;
   END
   $$`,
  `ALTER TABLE IF EXISTS chat_threads ADD COLUMN IF NOT EXISTS closed_at bigint`,
  `ALTER TABLE IF EXISTS chat_threads ADD COLUMN IF NOT EXISTS terminal_event text`,
  `ALTER TABLE IF EXISTS chat_threads ADD COLUMN IF NOT EXISTS terminal_entity_id text`,
  `ALTER TABLE IF EXISTS chat_threads ADD COLUMN IF NOT EXISTS posture text NOT NULL DEFAULT 'triage'`,
  `ALTER TABLE IF EXISTS chat_threads DROP COLUMN IF EXISTS context_seeded`,
  `ALTER TABLE IF EXISTS chat_threads DROP COLUMN IF EXISTS session_id`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chat_threads'
          AND column_name = 'closed_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE chat_threads
         ALTER COLUMN closed_at TYPE bigint
         USING (EXTRACT(EPOCH FROM closed_at::timestamptz) * 1000)::bigint;
     END IF;
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chat_threads'
          AND column_name = 'created_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE chat_threads
         ALTER COLUMN created_at TYPE bigint
         USING (EXTRACT(EPOCH FROM created_at::timestamptz) * 1000)::bigint;
     END IF;
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chat_threads'
          AND column_name = 'updated_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE chat_threads
         ALTER COLUMN updated_at TYPE bigint
         USING (EXTRACT(EPOCH FROM updated_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `CREATE INDEX IF NOT EXISTS idx_chat_threads_alert_item_id
     ON chat_threads(alert_item_id)`,
  `DROP INDEX IF EXISTS idx_chat_threads_evaporated_at`,
  `CREATE INDEX IF NOT EXISTS idx_chat_threads_closed_at
     ON chat_threads(closed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_threads_terminal_event_entity
     ON chat_threads(terminal_event, terminal_entity_id)
     WHERE closed_at IS NULL`,
  `ALTER TABLE IF EXISTS chat_threads ADD COLUMN IF NOT EXISTS parent_thread_id text`,
  `ALTER TABLE IF EXISTS chat_threads ADD COLUMN IF NOT EXISTS fork_idempotency_key text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_threads_fork_idem
     ON chat_threads(parent_thread_id, fork_idempotency_key)
     WHERE fork_idempotency_key IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id         text PRIMARY KEY,
    thread_id  text NOT NULL REFERENCES chat_threads(id),
    role       text NOT NULL,
    content    text NOT NULL,
    segments   text,
    created_at bigint NOT NULL,
    seq        bigint GENERATED ALWAYS AS IDENTITY
  )`,
  // Backfill `seq` for databases created before this column was added.
  // IF NOT EXISTS makes this idempotent on fresh databases (where seq already
  // exists from the CREATE TABLE above).
  `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY`,
  // Chat message envelope: kind ('validation' | 'acknowledgment' | 'situation') and optional
  // backing entity link for auto-clear projection (slice 1 of PRD cdf6a60a).
  `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'acknowledgment'`,
  `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS backing_entity_id text`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chat_messages'
          AND column_name = 'created_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE chat_messages
         ALTER COLUMN created_at TYPE bigint
         USING (EXTRACT(EPOCH FROM created_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_id
     ON chat_messages(thread_id)`,
  `CREATE TABLE IF NOT EXISTS chat_thread_tasks (
    thread_id  text        NOT NULL,
    task_id    text        NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (thread_id, task_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_thread_tasks_thread_created
     ON chat_thread_tasks(thread_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS chat_feedback (
    message_id text PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
    thread_id  text NOT NULL,
    rating     text NOT NULL CHECK (rating IN ('up','down')),
    note       text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
  )`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chat_feedback'
          AND column_name = 'created_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE chat_feedback
         ALTER COLUMN created_at TYPE bigint
         USING (EXTRACT(EPOCH FROM created_at::timestamptz) * 1000)::bigint;
     END IF;
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chat_feedback'
          AND column_name = 'updated_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE chat_feedback
         ALTER COLUMN updated_at TYPE bigint
         USING (EXTRACT(EPOCH FROM updated_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `CREATE INDEX IF NOT EXISTS idx_chat_feedback_rating ON chat_feedback(rating)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_feedback_thread_id
     ON chat_feedback(thread_id)`,

  // ── notices ───────────────────────────────────────────────────────────────
  // Entity-less informational bell messages (ADR-0079). Unlike an Alert (which
  // derives from arc state and clears when its entity resolves), a Notice has
  // no backing entity, so it clears only when the operator acknowledges it —
  // `acknowledged_at` stamps that gesture.
  `CREATE TABLE IF NOT EXISTS notices (
    id                text PRIMARY KEY,
    kind              text NOT NULL,
    payload           text NOT NULL DEFAULT '{}',
    body              text NOT NULL,
    source            text,
    failure_signature text,
    count             integer NOT NULL DEFAULT 1,
    created_at        text NOT NULL,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    acknowledged_at   text
  )`,
  // Existing Notice rows predate recipe-backed rendering. Keep them readable
  // while new writes always provide their own typed kind and payload.
  `ALTER TABLE IF EXISTS notices ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'spend-control-notice'`,
  `ALTER TABLE IF EXISTS notices ADD COLUMN IF NOT EXISTS payload text NOT NULL DEFAULT '{}'`,
  `ALTER TABLE IF EXISTS notices ADD COLUMN IF NOT EXISTS failure_signature text`,
  `ALTER TABLE IF EXISTS notices ADD COLUMN IF NOT EXISTS count integer NOT NULL DEFAULT 1`,
  `ALTER TABLE IF EXISTS notices ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`,
  `CREATE INDEX IF NOT EXISTS idx_notices_acknowledged_at ON notices(acknowledged_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_notices_open_failure_signature
     ON notices(failure_signature) WHERE acknowledged_at IS NULL`,
  // A Notice's chat mirror is an updateable projection rather than an
  // append-only transcript entry. Add this after `notices` exists so the FK
  // remains valid for fresh databases as well as upgrades.
  `ALTER TABLE IF EXISTS chat_messages
     ADD COLUMN IF NOT EXISTS notice_id text REFERENCES notices(id) ON DELETE CASCADE`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_messages_notice_id
     ON chat_messages(notice_id) WHERE notice_id IS NOT NULL`,

  // ── settings / preferences ────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS app_settings (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS preferences (
    name  text PRIMARY KEY,
    value text NOT NULL
  )`,

  // ── diagnoses ─────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS diagnoses_root_cause (
    task_id       text PRIMARY KEY,
    evidence      text NOT NULL,
    fix_direction text NOT NULL,
    recorded_at   bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS diagnoses_inconclusive (
    task_id      text PRIMARY KEY,
    what_checked text NOT NULL,
    why_unscoped text NOT NULL,
    recorded_at  bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS diagnosis_involved_files (
    task_id  text   NOT NULL,
    position bigint NOT NULL,
    path     text   NOT NULL,
    PRIMARY KEY (task_id, position)
  )`,

  // ── verify gates ──────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS gate_enrichment (
    signature            text   PRIMARY KEY,
    status               text   NOT NULL,
    encodable_family     text,
    non_encodable_reason text,
    step_spec            text,
    origin_task_id       text   NOT NULL,
    seen_count           bigint NOT NULL DEFAULT 1,
    created_at           bigint NOT NULL,
    updated_at           bigint NOT NULL,
    approved_by          text,
    approved_at          bigint,
    retired_at           bigint
  )`,
  `CREATE TABLE IF NOT EXISTS gate_burn_in (
    gate_name   text   PRIMARY KEY,
    parse_count bigint NOT NULL DEFAULT 0,
    promoted_at bigint
  )`,
  `CREATE TABLE IF NOT EXISTS gate_verdict_monitor (
    id              bigint PRIMARY KEY CHECK (id = 1),
    current_verdict text,
    streak_count    bigint NOT NULL DEFAULT 0,
    last_task_id    text,
    updated_at      bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS gate_suppressed_verdicts (
    verdict    text PRIMARY KEY,
    tripped_at bigint NOT NULL
  )`,
  // Signature-storm circuit breaker: singleton streak row that counts
  // consecutive identical failure signatures across DIFFERENT origin tasks.
  // When the streak reaches the threshold, `tripped` is set to true and
  // dispatch pauses + spawns a steward. Reset by any successful
  // task completion (streak_count=0, tripped=false). Singleton via CHECK(id=1).
  `CREATE TABLE IF NOT EXISTS failure_signature_streak (
    id                  bigint PRIMARY KEY CHECK (id = 1),
    current_signature   text,
    streak_count        bigint  NOT NULL DEFAULT 0,
    last_task_id        text,
    tripped             boolean NOT NULL DEFAULT false,
    updated_at          timestamptz NOT NULL
  )`,
  `ALTER TABLE failure_signature_streak
     ALTER COLUMN updated_at TYPE timestamptz USING updated_at::timestamptz`,
  `CREATE TABLE IF NOT EXISTS verify_gates (
    id         text PRIMARY KEY,
    scope      text NOT NULL DEFAULT '.',
    name       text NOT NULL,
    cmd        text NOT NULL,
    args_json  text NOT NULL DEFAULT '[]',
    required   INTEGER NOT NULL DEFAULT 1,
    tier       text NOT NULL DEFAULT 'task',
    source     text NOT NULL DEFAULT 'human',
    created_at bigint NOT NULL,
    UNIQUE(scope, name)
  )`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'diagnoses_root_cause'
          AND column_name = 'recorded_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE diagnoses_root_cause ALTER COLUMN recorded_at TYPE bigint
         USING (EXTRACT(EPOCH FROM recorded_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'diagnoses_inconclusive'
          AND column_name = 'recorded_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE diagnoses_inconclusive ALTER COLUMN recorded_at TYPE bigint
         USING (EXTRACT(EPOCH FROM recorded_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'gate_enrichment'
          AND column_name = 'created_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE gate_enrichment ALTER COLUMN created_at TYPE bigint
         USING (EXTRACT(EPOCH FROM created_at::timestamptz) * 1000)::bigint;
     END IF;
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'gate_enrichment'
          AND column_name = 'updated_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE gate_enrichment ALTER COLUMN updated_at TYPE bigint
         USING (EXTRACT(EPOCH FROM updated_at::timestamptz) * 1000)::bigint;
     END IF;
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'gate_enrichment'
          AND column_name = 'approved_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE gate_enrichment ALTER COLUMN approved_at TYPE bigint
         USING (EXTRACT(EPOCH FROM approved_at::timestamptz) * 1000)::bigint;
     END IF;
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'gate_enrichment'
          AND column_name = 'retired_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE gate_enrichment ALTER COLUMN retired_at TYPE bigint
         USING (EXTRACT(EPOCH FROM retired_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'gate_burn_in'
          AND column_name = 'promoted_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE gate_burn_in ALTER COLUMN promoted_at TYPE bigint
         USING (EXTRACT(EPOCH FROM promoted_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'gate_verdict_monitor'
          AND column_name = 'updated_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE gate_verdict_monitor ALTER COLUMN updated_at TYPE bigint
         USING (EXTRACT(EPOCH FROM updated_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'gate_suppressed_verdicts'
          AND column_name = 'tripped_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE gate_suppressed_verdicts ALTER COLUMN tripped_at TYPE bigint
         USING (EXTRACT(EPOCH FROM tripped_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'verify_gates'
          AND column_name = 'created_at' AND data_type <> 'bigint'
     ) THEN
       ALTER TABLE verify_gates ALTER COLUMN created_at TYPE bigint
         USING (EXTRACT(EPOCH FROM created_at::timestamptz) * 1000)::bigint;
     END IF;
   END
   $$`,

  // ── KPIs / scoring / promotion ────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS kpi_snapshots (
    id text PRIMARY KEY,
    taken_at     text NOT NULL,
    window_start text NOT NULL,
    window_end   text NOT NULL,
    cost_per_arc_sample_count                 bigint NOT NULL,
    cost_per_arc_low_confidence               bigint NOT NULL,
    failure_rate_sample_count                 bigint NOT NULL,
    failure_rate_low_confidence               bigint NOT NULL,
    autonomous_completion_rate_sample_count   bigint NOT NULL,
    autonomous_completion_rate_low_confidence bigint NOT NULL,
    recovery_success_rate_sample_count        bigint NOT NULL,
    recovery_success_rate_low_confidence      bigint NOT NULL,
    cost_per_arc_p50           double precision,
    cost_per_arc_p90           double precision,
    failure_rate               double precision,
    autonomous_completion_rate double precision,
    recovery_success_rate      double precision
  )`,
  `CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_taken_at
     ON kpi_snapshots(taken_at)`,
  // Simple key/value counter table for KPI event counters (e.g. rescue_attempts_total).
  `CREATE TABLE IF NOT EXISTS kpi_counters (
    key   text PRIMARY KEY,
    value bigint NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS promotion_ledger (
    id                   text   PRIMARY KEY,
    workflow             text   NOT NULL,
    candidate_version_id text   NOT NULL,
    incumbent_version_id text   NOT NULL,
    candidate_score      double precision,
    incumbent_score      double precision,
    candidate_n          bigint NOT NULL DEFAULT 0,
    incumbent_n          bigint NOT NULL DEFAULT 0,
    decision             text   NOT NULL DEFAULT 'pending'
                                CHECK (decision IN ('promoted','retired','pending')),
    decided_at           bigint,
    created_at           bigint NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_promotion_ledger_workflow
     ON promotion_ledger(workflow, created_at DESC)`,
  // output_contract default mirrors SCORER_OUTPUT_CONTRACT in core/scorers.ts
  // (inlined so the canonical schema stays dependency-free).
  `CREATE TABLE IF NOT EXISTS scorers (
    id              text   PRIMARY KEY,
    workflow        text   NOT NULL,
    title           text   NOT NULL,
    rubric          text   NOT NULL,
    output_contract text   NOT NULL DEFAULT 'continuous-0-1-with-one-line-rationale',
    status          text   NOT NULL DEFAULT 'suggested',
    origin_arc_id   text   NOT NULL,
    report_path     text,
    evidence        text   NOT NULL DEFAULT '[]',
    confidence      double precision NOT NULL DEFAULT 0.5,
    fingerprint     text   NOT NULL,
    created_at      bigint NOT NULL,
    updated_at      bigint NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scorers_fingerprint ON scorers(fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_scorers_status ON scorers(status)`,
  `CREATE TABLE IF NOT EXISTS scorer_results (
    id                         text   PRIMARY KEY,
    scorer_id                  text   NOT NULL,
    task_id                    text   NOT NULL,
    workflow                   text   NOT NULL,
    score                      double precision,
    rationale                  text   NOT NULL DEFAULT '',
    status                     text   NOT NULL DEFAULT 'scored'
                                      CHECK (status IN ('scored','error')),
    created_at                 bigint NOT NULL,
    workflow_config_version_id text
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_scorer_results_scorer_task
     ON scorer_results(scorer_id, task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_scorer_results_workflow
     ON scorer_results(workflow, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_scorer_results_task ON scorer_results(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_scorer_results_workflow_config_version
     ON scorer_results(workflow, workflow_config_version_id)`,
  `CREATE TABLE IF NOT EXISTS workflow_configs (
    id          text   PRIMARY KEY,
    workflow    text   NOT NULL,
    version     bigint NOT NULL,
    config_hash text   NOT NULL,
    status      text   NOT NULL DEFAULT 'baseline',
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL,
    UNIQUE (workflow, version)
  )`,
  `CREATE TABLE IF NOT EXISTS tool_promotion_attempts (
    id                 text   PRIMARY KEY,
    helper_key         text   NOT NULL,
    motivating_arc_ids text   NOT NULL,
    status             text   NOT NULL
                              CHECK (status IN ('proposed','benchmarked','promoted','retired')),
    benchmark_before   text,
    benchmark_after    text,
    created_at         bigint NOT NULL,
    decided_at         bigint
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_promotion_status
     ON tool_promotion_attempts(status)`,

  // ── memory packets ────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS memory_packets (
    id            text PRIMARY KEY,
    domain        text NOT NULL,
    text          text NOT NULL,
    salience      double precision NOT NULL CHECK (salience BETWEEN 0 AND 1),
    origin_arc_id text,
    created_at    text NOT NULL,
    retired_at    text
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_packets_domain_salience
     ON memory_packets(domain, retired_at, salience DESC)`,

  // ── @mars/workflow engine checkpoint state (queue-workflow-store.ts) ──────
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    id          text   PRIMARY KEY,
    workflow_id text   NOT NULL,
    input_json  text   NOT NULL,
    status      text   NOT NULL,
    created_at  bigint NOT NULL,
    updated_at  bigint NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_step_runs (
    run_id         text   NOT NULL,
    step_name      text   NOT NULL,
    status         text   NOT NULL,
    sha            text,
    started_at     bigint NOT NULL,
    finished_at    bigint,
    attempt        bigint NOT NULL,
    summary        text,
    error_summary  text,
    transcript_key text,
    result_json    text,
    seq            bigint NOT NULL,
    PRIMARY KEY (run_id, step_name)
  )`,

  // ── merge queue ───────────────────────────────────────────────────────────
  // Durable single-consumer merge queue (PRD 92af89ce). Each row represents
  // one pending, in-flight, or terminal merge attempt for a task branch.
  // The partial unique index below ensures at most one active job per task.
  `CREATE TABLE IF NOT EXISTS merge_jobs (
    id                 uuid        PRIMARY KEY,
    task_id            text        NOT NULL REFERENCES tasks(id),
    status             text        NOT NULL DEFAULT 'queued'
                                   CHECK (status IN ('queued','claimed','running','done','failed','canceled')),
    attempts           integer     NOT NULL DEFAULT 0,
    claimed_at         timestamptz NULL,
    started_at         timestamptz NULL,
    finished_at        timestamptz NULL,
    error              text        NULL,
    error_code         text        NULL,
    integration_branch text        NOT NULL,
    worktree_path      text        NOT NULL,
    branch             text        NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
  )`,
  // At most one active (queued/claimed/running) merge job per task_id.
  `CREATE UNIQUE INDEX IF NOT EXISTS merge_jobs_active_task_uidx
     ON merge_jobs(task_id)
     WHERE status IN ('queued', 'claimed', 'running')`,

  // ── task deployments ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS task_deployments (
    deployment_id text        PRIMARY KEY,
    task_id       text        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    provider      text        NOT NULL,
    url           text,
    status        text        NOT NULL CHECK (status IN ('pending','ready','failed')),
    error         text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_deployments_task
     ON task_deployments(task_id, created_at DESC)`,
  // Backfill torn_down_at for databases created before teardown support (PRD 268cbb5a).
  `ALTER TABLE task_deployments ADD COLUMN IF NOT EXISTS torn_down_at timestamptz`,

  // ── learned recipes (operator-taught auto-run rules) ─────────────────────
  // Per failure signature, global: the operator teaches a recovery op once
  // and the system auto-executes it on every subsequent occurrence of the
  // same failure signature instead of raising a card (recipe-teaching ADR).
  `CREATE TABLE IF NOT EXISTS learned_recipes (
    failure_signature text PRIMARY KEY,
    action_op         text NOT NULL,
    learned_at        text NOT NULL
  )`,

  // Auto-run log: one row per auto-executed learned recipe, newest-first.
  // Used by the WYWA delta to surface background recoveries to the operator.
  `CREATE TABLE IF NOT EXISTS auto_recipe_runs (
    id            text PRIMARY KEY,
    signature     text NOT NULL,
    action_op     text NOT NULL,
    task_id       text,
    ran_at        text NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auto_recipe_runs_ran_at
     ON auto_recipe_runs(ran_at DESC)`,

  // ── Steward intervention ledger ─────────────────────────────────────────
  // Append-only evidence for every proactive Steward action. The target
  // version (or content hash) is part of the lookup key so a later version
  // remains eligible for a fresh intervention.
  `CREATE TABLE IF NOT EXISTS steward_ledger (
    id             text        PRIMARY KEY,
    ts             timestamptz NOT NULL,
    target_kind    text        NOT NULL,
    target_id      text        NOT NULL,
    target_version text        NOT NULL,
    recipe_id      text        NOT NULL,
    rationale      text        NOT NULL,
    outcome        text        NOT NULL,
    commit_sha     text        NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_steward_ledger_target_version
     ON steward_ledger(target_kind, target_id, target_version)`,
  // Drop the per-task preview command column: the --preview CLI flag and the
  // preview_cmd column are removed (PRD f354b404 slice 1). Existing rows have
  // the column dropped idempotently; tasks now carry no per-task preview command.
  `ALTER TABLE IF EXISTS tasks DROP COLUMN IF EXISTS preview_cmd`,

  // ── daemon liveness (single-row heartbeat) ────────────────────────────────
  // Written by startHeartbeatWriter on every daemon boot and updated on a
  // fixed interval (default 5 s, env-tunable via MARS_HEARTBEAT_MS). The
  // CHECK(id = 1) enforces single-row: we always upsert id=1 so there is
  // never more than one row. boot_ts is refreshed on each daemon start so
  // the row accurately reflects the CURRENT daemon instance.
  `CREATE TABLE IF NOT EXISTS daemon_heartbeat (
    id           bigint      PRIMARY KEY CHECK (id = 1),
    pid          bigint      NOT NULL,
    boot_ts      timestamptz NOT NULL,
    last_beat_ts timestamptz NOT NULL
  )`,
  // Outage gap column: milliseconds the daemon was offline before the most
  // recent boot. Written by startHeartbeatWriter so elapsed-time watchdogs
  // can rebase task deadlines after a prolonged downtime.
  `ALTER TABLE IF EXISTS daemon_heartbeat ADD COLUMN IF NOT EXISTS prev_gap_ms bigint`,
  // Cumulative milliseconds for which a live daemon had dispatch enabled.
  // Unlike wall clock, this does not advance while paused or between boots.
  `ALTER TABLE IF EXISTS daemon_heartbeat ADD COLUMN IF NOT EXISTS dispatch_uptime_ms bigint NOT NULL DEFAULT 0`,

  // ── dispatch spend controller (migration 0003) ────────────────────────────
  // Single-row operator-set control levers for the dispatch spend controller.
  // Seeded on first read via the store's loadSpendControl defaults.
  `CREATE TABLE IF NOT EXISTS dispatch_spend_control (
    id                  bigint      PRIMARY KEY CHECK (id = 1),
    per_kind_ceilings   jsonb,
    pause_threshold_pct integer     NOT NULL DEFAULT 90,
    resume_threshold_pct integer    NOT NULL DEFAULT 70,
    suppress_recovery   boolean     NOT NULL DEFAULT false,
    ramp_back_step_pct  integer     NOT NULL DEFAULT 10,
    updated_at          timestamptz NOT NULL DEFAULT now()
  )`,

  // ── purge archive (slice 3 of PRD aa93d9cb) ──────────────────────────────
  // Evidence log of every force-purged task. Written before the task row is
  // deleted so lifecycle evidence survives the purge operation. Query via
  // `mars purge log`. Archive is evidence-only: a failed insert is logged and
  // the purge still returns success.
  `CREATE TABLE IF NOT EXISTS purged_tasks_archive (
    id                     text        PRIMARY KEY,
    origin_id              text,
    branch                 text,
    worktree_path          text,
    terminal_status        text,
    kind                   text,
    prompt                 text,
    intent                 text,
    integrated_commits_json text,
    compensation_task_id   text,
    purged_at              timestamptz NOT NULL DEFAULT now(),
    purged_by              text,
    force_flag             boolean     NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_purged_tasks_archive_origin
     ON purged_tasks_archive(origin_id)`,
  `CREATE INDEX IF NOT EXISTS idx_purged_tasks_archive_purged_at
     ON purged_tasks_archive(purged_at DESC)`,

  // ── workflow patch proposals (steward diff-for-validation) ─────────────────
  `CREATE TABLE IF NOT EXISTS workflow_patch_proposals (
    id              text PRIMARY KEY,
    workflow_path   text NOT NULL,
    unified_diff    text NOT NULL,
    rationale       text NOT NULL,
    status          text NOT NULL DEFAULT 'awaiting-human',
    created_at      timestamptz NOT NULL DEFAULT now()
  )`,

  // ── usage snapshots (slice 2 of PRD 9888811c) ────────────────────────────
  // Periodic daemon samples of token usage. Read by `mars daemon usage` and
  // the future usage-aware scheduler. Forward-only — append rows, never mutate.
  `CREATE TABLE IF NOT EXISTS usage_snapshots (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    captured_at   timestamptz NOT NULL DEFAULT now(),
    input_tokens  bigint NOT NULL DEFAULT 0,
    output_tokens bigint NOT NULL DEFAULT 0,
    window_kind   text NOT NULL,
    raw_json      jsonb NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_snapshots_captured_at
     ON usage_snapshots(captured_at DESC)`,

  // ── worker MCP mutation audit (slice 6 of PRD 57e134df) ──────────────────
  // One immutable row per mutation call issued by a dispatched worker. Args
  // are redacted by the MCP server before crossing the daemon boundary.
  `CREATE TABLE IF NOT EXISTS mcp_worker_audit (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tool_name     text        NOT NULL,
    task_id       text        NOT NULL,
    args_json     jsonb       NOT NULL,
    ok            boolean     NOT NULL,
    error_message text,
    created_at    timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_worker_audit_task_created
     ON mcp_worker_audit(task_id, created_at DESC)`,

  // ── dispatch deferrals (slice 5 of PRD 9888811c) ─────────────────────────
  // One current scheduling decision per task. Repeated daemon boots update the
  // same row rather than accumulating stale copies of a deferred task.
  `CREATE TABLE IF NOT EXISTS deferrals (
    task_id           text PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    deferred_at       timestamptz NOT NULL,
    reason            text NOT NULL,
    target_window_end timestamptz,
    pressure          text NOT NULL
  )`,
]

/**
 * Every table the canonical schema owns. The importer intersects this set
 * with the tables found in a legacy mars.db to decide what to copy.
 */
export const SCHEMA_TABLES: readonly string[] = [
  'schema_migrations',
  'proposals',
  'proposal_user_stories',
  'proposal_dependencies',
  'proposal_notes',
  'tasks',
  'task_terminal_reopens',
  'task_blockers',
  'task_proposal_blockers',
  'task_acceptance',
  'self_heal_attempts',
  'non_code_requeue_attempts',
  'task_claude_sessions',
  'task_spec_files',
  'task_done_criteria',
  'questions',
  'task_progress',
  'trace_events',
  'task_transcripts',
  'task_durable_transcripts',
  'events',
  'subscribers',
  'subscriber_processed_events',
  'subscriber_stalls',
  'signals',
  'action_queue_items',
  'action_queue_history',
  'chat_threads',
  'arc_rescue_attempts',
  'chat_messages',
  'chat_thread_tasks',
  'chat_feedback',
  'app_settings',
  'preferences',
  'notices',
  'diagnoses_root_cause',
  'diagnoses_inconclusive',
  'diagnosis_involved_files',
  'gate_enrichment',
  'gate_burn_in',
  'gate_verdict_monitor',
  'gate_suppressed_verdicts',
  'failure_signature_streak',
  'verify_gates',
  'kpi_snapshots',
  'kpi_counters',
  'promotion_ledger',
  'scorers',
  'scorer_results',
  'workflow_configs',
  'tool_promotion_attempts',
  'memory_packets',
  'workflow_runs',
  'workflow_step_runs',
  'learned_recipes',
  'auto_recipe_runs',
  'steward_ledger',
  'merge_jobs',
  'task_deployments',
  'dispatch_spend_control',
  'purged_tasks_archive',
  'workflow_patch_proposals',
  'usage_snapshots',
  'mcp_worker_audit',
  'daemon_heartbeat',
  'deferrals',
]

/**
 * Tables whose primary key is a `GENERATED ALWAYS AS IDENTITY` column.
 * Inserting explicit ids into these requires `OVERRIDING SYSTEM VALUE`
 * (the importer) and the sequence must be re-synced with setval afterwards.
 */
export const IDENTITY_COLUMNS: Readonly<Record<string, string>> = {
  events: 'id',
  self_heal_attempts: 'id',
  non_code_requeue_attempts: 'id',
  task_terminal_reopens: 'id',
  chat_messages: 'seq',
  usage_snapshots: 'id',
  mcp_worker_audit: 'id',
}

/**
 * A fixed 64-bit key for the PostgreSQL advisory lock that serializes
 * concurrent `ensureSchema` callers. Constant across all processes so
 * every caller agrees on the same lock. Exported so tests can reference it.
 */
export const SCHEMA_ADVISORY_LOCK_KEY = 20260726

/**
 * Applies the complete canonical schema (idempotent) and records
 * SCHEMA_VERSION in schema_migrations. Safe to run at every startup;
 * everything executes in one transaction (PostgreSQL DDL is transactional).
 *
 * Concurrent callers are serialized by a PostgreSQL advisory lock so that
 * two interleaved `ensureSchema` batches cannot deadlock on the
 * AccessExclusiveLock each DDL statement takes on `tasks`. The xact-scoped
 * variant auto-releases when the wrapping transaction commits or rolls back —
 * no explicit unlock is required.
 *
 * Implementation note: this function uses `__execSchemaBatch` (a raw
 * transaction helper exported from db.ts) instead of `client.batch`.
 * `client.batch` calls `ensureClientSchema` internally, which would
 * recursively trigger `ensureSchema` (caught by the re-entry guard), and then
 * the outer `client.batch` would run the SAME DDL a second time in a separate
 * transaction.  That double-transaction leaves a window between the two
 * commits where the advisory lock is not held, creating an opportunity for a
 * DML-DDL deadlock with the running daemon.  `__execSchemaBatch` bypasses the
 * schema-bootstrap guard entirely so the DDL executes in exactly one
 * transaction.
 */
export async function ensureSchema(client: DbClient): Promise<void> {
  await __execSchemaBatch(client, [
    // Serialize concurrent callers: DDL takes AccessExclusiveLock on
    // `tasks`, so two interleaved ensureSchema batches deadlock. This
    // advisory lock makes the second caller wait until the first commits.
    // pg_advisory_xact_lock auto-releases on COMMIT/ROLLBACK.
    { sql: 'SELECT pg_advisory_xact_lock(?)', args: [SCHEMA_ADVISORY_LOCK_KEY] },
    ...DDL,
    {
      sql: `INSERT INTO schema_migrations (version, applied_at)
            VALUES (?, ?) ON CONFLICT (version) DO NOTHING`,
      args: [SCHEMA_VERSION, new Date().toISOString()],
    },
  ])
}
