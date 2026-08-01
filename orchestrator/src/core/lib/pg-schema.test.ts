import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { __execSchemaBatch, __resetDbRegistryForTests, openDb, type DbClient } from './db.js'
import {
  ensureSchema,
  IDENTITY_COLUMNS,
  SCHEMA_ADVISORY_LOCK_KEY,
  SCHEMA_TABLES,
  SCHEMA_VERSION,
} from './pg-schema.js'

let keyCounter = 0
const freshKey = (): string => `pg-schema-test-${process.pid}-${(keyCounter += 1)}`

beforeAll(() => {
  process.env.MARS_DB_BACKEND = 'pglite'
})

afterEach(async () => {
  await __resetDbRegistryForTests()
})

const freshSchemaClient = async (): Promise<DbClient> => {
  const c = openDb(freshKey())
  await ensureSchema(c)
  return c
}

const columnsOf = async (c: DbClient, table: string): Promise<Map<string, string>> => {
  const r = await c.execute(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ?`,
    [table],
  )
  return new Map(r.rows.map((row) => [row.column_name as string, row.data_type as string]))
}

describe('ensureSchema', () => {
  it('creates every canonical table', async () => {
    const c = await freshSchemaClient()
    const r = await c.execute(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )
    const present = new Set(r.rows.map((row) => row.table_name as string))
    for (const table of SCHEMA_TABLES) {
      expect(present, `missing table ${table}`).toContain(table)
    }
    // And nothing beyond the canonical set.
    expect(present.size).toBe(SCHEMA_TABLES.length)
  })

  it('is idempotent (second run is a no-op, one version row)', async () => {
    const c = await freshSchemaClient()
    await ensureSchema(c)
    const r = await c.execute('SELECT version FROM schema_migrations')
    expect(r.rows).toEqual([{ version: SCHEMA_VERSION }])
  })

  it('creates chat threads without provider-session columns', async () => {
    const c = await freshSchemaClient()
    const columns = await columnsOf(c, 'chat_threads')

    expect(columns.has('session_id')).toBe(false)
    expect(columns.has('context_seeded')).toBe(false)
  })

  it('stores operational chat timestamps as epoch milliseconds', async () => {
    const c = await freshSchemaClient()

    expect(Object.fromEntries(await columnsOf(c, 'chat_threads'))).toMatchObject({
      evaporated_at: 'bigint',
      created_at: 'bigint',
      updated_at: 'bigint',
    })
    expect((await columnsOf(c, 'chat_messages')).get('created_at')).toBe('bigint')
    expect(Object.fromEntries(await columnsOf(c, 'chat_feedback'))).toMatchObject({
      created_at: 'bigint',
      updated_at: 'bigint',
    })
  })

  it('migrates legacy chat timestamps to epoch milliseconds without losing rows', async () => {
    const c = openDb(freshKey())
    try {
      await __execSchemaBatch(c, [
        `CREATE TABLE chat_threads (
          id text PRIMARY KEY,
          title text NOT NULL,
          status text NOT NULL,
          posture text NOT NULL,
          origin text,
          alert_item_id text,
          alert_resolved bigint NOT NULL,
          evaporated_at text,
          session_id text,
          context_seeded bigint,
          created_at text NOT NULL,
          updated_at text NOT NULL
        )`,
        `CREATE TABLE chat_messages (
          id text PRIMARY KEY,
          thread_id text NOT NULL REFERENCES chat_threads(id),
          role text NOT NULL,
          content text NOT NULL,
          segments text,
          created_at text NOT NULL
        )`,
        `CREATE TABLE chat_feedback (
          message_id text PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
          thread_id text NOT NULL,
          rating text NOT NULL,
          note text,
          created_at text NOT NULL,
          updated_at text NOT NULL
        )`,
        {
          sql: `INSERT INTO chat_threads
                  (id, title, status, posture, alert_resolved, evaporated_at, session_id, context_seeded, created_at, updated_at)
                VALUES ('legacy-thread', 'Keep me', 'idle', 'triage', 0, '1970-01-01T00:00:01.234Z', 'obsolete', 1, '1970-01-01T00:00:02.345Z', '1970-01-01T00:00:03.456Z')`,
        },
        {
          sql: `INSERT INTO chat_messages (id, thread_id, role, content, created_at)
                VALUES ('legacy-message', 'legacy-thread', 'user', 'Keep me too', '1970-01-01T00:00:04.567Z')`,
        },
        {
          sql: `INSERT INTO chat_feedback (message_id, thread_id, rating, created_at, updated_at)
                VALUES ('legacy-message', 'legacy-thread', 'up', '1970-01-01T00:00:05.678Z', '1970-01-01T00:00:06.789Z')`,
        },
      ])

      await ensureSchema(c)

      const columns = await columnsOf(c, 'chat_threads')
      expect(columns.has('session_id')).toBe(false)
      expect(columns.has('context_seeded')).toBe(false)
      expect(Object.fromEntries(columns)).toMatchObject({
        evaporated_at: 'bigint',
        created_at: 'bigint',
        updated_at: 'bigint',
      })
      const row = await c.execute(`SELECT id, title, evaporated_at, created_at, updated_at FROM chat_threads WHERE id = 'legacy-thread'`)
      expect(row.rows).toEqual([{
        id: 'legacy-thread', title: 'Keep me', evaporated_at: 1234, created_at: 2345, updated_at: 3456,
      }])
      expect((await c.execute(`SELECT created_at FROM chat_messages WHERE id = 'legacy-message'`)).rows)
        .toEqual([{ created_at: 4567 }])
      expect((await c.execute(`SELECT created_at, updated_at FROM chat_feedback WHERE message_id = 'legacy-message'`)).rows)
        .toEqual([{ created_at: 5678, updated_at: 6789 }])
      expect((await columnsOf(c, 'chat_messages')).get('created_at')).toBe('bigint')
      expect(Object.fromEntries(await columnsOf(c, 'chat_feedback'))).toMatchObject({
        created_at: 'bigint',
        updated_at: 'bigint',
      })
    } finally {
      await c.close()
    }
  })

  it('creates the worker MCP audit table with durable mutation evidence fields', async () => {
    const c = await freshSchemaClient()
    const cols = await columnsOf(c, 'mcp_worker_audit')
    expect(Object.fromEntries(cols)).toMatchObject({
      id: 'bigint',
      tool_name: 'text',
      task_id: 'text',
      args_json: 'jsonb',
      ok: 'boolean',
      error_message: 'text',
      created_at: 'timestamp with time zone',
    })

    const inserted = await c.execute(
      `INSERT INTO mcp_worker_audit (tool_name, task_id, args_json, ok, error_message)
       VALUES ('mars_task_note', 'mars-audit-001', '{"body":"[redacted]"}', false, 'daemon unavailable')
       RETURNING tool_name, task_id, args_json, ok, error_message, created_at`,
    )
    expect(inserted.rows[0]).toMatchObject({
      tool_name: 'mars_task_note',
      task_id: 'mars-audit-001',
      args_json: { body: '[redacted]' },
      ok: false,
      error_message: 'daemon unavailable',
    })
    expect(inserted.rows[0].created_at).toBeTruthy()
  })

  it('normalizes obsolete rejected proposal rows to dismissed during schema bootstrap', async () => {
    const c = await freshSchemaClient()
    await c.execute(
      `INSERT INTO proposals (id, status, created_at, updated_at)
       VALUES ('legacy-rejected', 'rejected', 1, 1)`,
    )

    await ensureSchema(c)

    const r = await c.execute(`SELECT status FROM proposals WHERE id = 'legacy-rejected'`)
    expect(r.rows).toEqual([{ status: 'dismissed' }])
  })

  it('two concurrent calls both resolve without a deadlock error', async () => {
    // Verify that SCHEMA_ADVISORY_LOCK_KEY is exported and is a number —
    // it is the constant every process uses to name the advisory lock.
    expect(typeof SCHEMA_ADVISORY_LOCK_KEY).toBe('number')

    // Start from an empty database so both legs race to apply the full DDL.
    const c = openDb(freshKey())
    try {
      // Both calls resolve; neither throws. On the embedded backend the
      // advisory lock would queue the second caller instead of deadlocking.
      await Promise.all([ensureSchema(c), ensureSchema(c)])
      const r = await c.execute('SELECT version FROM schema_migrations')
      // Exactly one version row — the ON CONFLICT guard plus the advisory
      // lock's serialisation mean the row is written once.
      expect(r.rows).toEqual([{ version: SCHEMA_VERSION }])
    } finally {
      await c.close()
    }
  })

  it('tasks has the full canonical column set with translated types', async () => {
    const c = await freshSchemaClient()
    const cols = await columnsOf(c, 'tasks')
    for (const name of [
      'id', 'prompt', 'status', 'plan_functional', 'plan_technical', 'branch',
      'worktree_path', 'claude_session_id', 'error', 'drop_reason',
      'retry_count', 'author_kind', 'author_name', 'failure_reason',
      'failure_reason_code', 'recovery_payload', 'fix_for_task_id',
      'failure_signature', 'kind', 'priority', 'tag', 'tags_json', 'origin_id',
      'parent_proposal_id', 'slice_index', 'failed_phase', 'resume_from',
      'verify_cmd', 'dev_server_url', 'dev_server_pid',
      'preview_validated', 'task_type', 'read_first_json',
      'prescriptive_action', 'slice_kind', 'sub_deliverable_json',
      'integration_head_sha', 'followup_dedup_key', 'intent', 'lease_owner',
      'leased_at', 'lease_note', 'origin_session_id', 'workflow',
      'current_step_name', 'current_step_guide', 'compensates_arc_id',
      'created_at', 'updated_at',
    ]) {
      expect(cols.has(name), `tasks.${name} missing`).toBe(true)
    }
    expect(cols.get('id')).toBe('text')
    expect(cols.get('retry_count')).toBe('bigint')
    expect(cols.get('priority')).toBe('bigint')
    expect(cols.get('leased_at')).toBe('timestamp with time zone')
    expect(cols.get('created_at')).toBe('timestamp with time zone')
    expect(cols.get('updated_at')).toBe('timestamp with time zone')
  })

  it('events is a bigint identity outbox with an epoch default', async () => {
    const c = await freshSchemaClient()
    const cols = await columnsOf(c, 'events')
    expect(cols.get('id')).toBe('bigint')
    expect(cols.get('ts')).toBe('bigint')
    const r1 = await c.execute(
      `INSERT INTO events (type, payload) VALUES ('a', '{}') RETURNING id, ts`,
    )
    const r2 = await c.execute(
      `INSERT INTO events (type, payload) VALUES ('b', '{}') RETURNING id`,
    )
    // Monotonic identity + unixepoch()-equivalent default.
    expect(r2.rows[0].id).toBe((r1.rows[0].id as number) + 1)
    expect(r1.rows[0].ts as number).toBeGreaterThan(1_700_000_000)
    // GENERATED ALWAYS: a plain explicit id must be rejected.
    await expect(
      c.execute(`INSERT INTO events (id, type, payload) VALUES (999, 'c', '{}')`),
    ).rejects.toThrow()
  })

  it('stores trace event timestamps as epoch milliseconds', async () => {
    const c = await freshSchemaClient()
    const cols = await columnsOf(c, 'trace_events')

    expect(cols.get('timestamp')).toBe('bigint')
  })

  it('converts existing trace event timestamps to epoch milliseconds', async () => {
    const c = openDb(freshKey())
    try {
      await __execSchemaBatch(c, [`CREATE TABLE trace_events (
        id text PRIMARY KEY,
        timestamp text NOT NULL,
        kind text NOT NULL,
        severity text NOT NULL DEFAULT 'info',
        task_id text,
        origin_id text,
        phase text,
        payload text NOT NULL DEFAULT '{}'
      )`, {
        sql: `INSERT INTO trace_events (id, timestamp, kind)
              VALUES ('legacy', '1970-01-01T00:00:01.234Z', 'step_started')`,
      }])

      await ensureSchema(c)

      const row = await c.execute(`SELECT timestamp FROM trace_events WHERE id = 'legacy'`)
      expect(row.rows[0].timestamp).toBe(1234)
      expect((await columnsOf(c, 'trace_events')).get('timestamp')).toBe('bigint')
    } finally {
      await c.close()
    }
  })

  it('converts existing action-queue timestamps to epoch milliseconds', async () => {
    const c = openDb(freshKey())
    try {
      await __execSchemaBatch(c, [`CREATE TABLE action_queue_items (
        id text PRIMARY KEY,
        kind text NOT NULL,
        category text NOT NULL,
        priority text NOT NULL,
        state text NOT NULL DEFAULT 'open',
        title text NOT NULL,
        body text NOT NULL DEFAULT '',
        payload text NOT NULL DEFAULT '{}',
        context text NOT NULL DEFAULT '{}',
        raised_by text NOT NULL,
        raised_at text NOT NULL,
        resolved_at text,
        resolution text,
        resolution_note text,
        root_cause text,
        fingerprint text,
        signature text,
        seen_count bigint NOT NULL DEFAULT 1,
        last_seen_at text,
        resolved_by text,
        origin_task_id text,
        snoozed_until text
      )`, `CREATE TABLE action_queue_history (
        id text PRIMARY KEY,
        item_id text NOT NULL REFERENCES action_queue_items(id),
        at text NOT NULL,
        from_state text,
        to_state text NOT NULL,
        "by" text,
        note text
      )`, {
        sql: `INSERT INTO action_queue_items (
                id, kind, category, priority, title, raised_by, raised_at,
                resolved_at, last_seen_at, snoozed_until
              ) VALUES (
                'legacy', 'failed', 'orchestrator', 'high', 'Legacy', 'daemon',
                '1970-01-01T00:00:01.234Z', '1970-01-01T00:00:02.345Z',
                '1970-01-01T00:00:03.456Z', '1970-01-01T00:00:04.567Z'
              )`,
      }, {
        sql: `INSERT INTO action_queue_history (id, item_id, at, to_state)
              VALUES ('legacy-history', 'legacy', '1970-01-01T00:00:05.678Z', 'open')`,
      }])

      await ensureSchema(c)

      const item = await c.execute(`SELECT raised_at, resolved_at, last_seen_at, snoozed_until
                                      FROM action_queue_items WHERE id = 'legacy'`)
      expect(item.rows[0]).toEqual({
        raised_at: 1234,
        resolved_at: 2345,
        last_seen_at: 3456,
        snoozed_until: 4567,
      })
      const history = await c.execute(`SELECT at FROM action_queue_history WHERE id = 'legacy-history'`)
      expect(history.rows[0].at).toBe(5678)
      const itemColumns = await columnsOf(c, 'action_queue_items')
      for (const column of ['raised_at', 'resolved_at', 'last_seen_at', 'snoozed_until']) {
        expect(itemColumns.get(column)).toBe('bigint')
      }
      expect((await columnsOf(c, 'action_queue_history')).get('at')).toBe('bigint')
    } finally {
      await c.close()
    }
  })

  it('task_blockers keeps state CHECK, provenance, and composite PK', async () => {
    const c = await freshSchemaClient()
    const cols = await columnsOf(c, 'task_blockers')
    expect(cols.get('provenance')).toBe('text')
    expect(cols.get('created_at')).toBe('bigint')
    const now = Date.now()
    await c.execute(
      `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
       VALUES ('t1', 'p', 'queued', ?, ?), ('t2', 'p', 'queued', ?, ?)`,
      [now, now, now, now],
    )
    await c.execute(
      `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES ('t1', 't2', ?)`,
      [now],
    )
    const row = await c.execute(
      `SELECT state, provenance FROM task_blockers WHERE task_id = 't1'`,
    )
    expect(row.rows[0]).toEqual({ state: 'confirmed', provenance: 'inferred' })
    // CHECK (state IN ...) enforced.
    await expect(
      c.execute(
        `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
         VALUES ('t2', 't1', 'bogus', ?)`,
        [now],
      ),
    ).rejects.toThrow()
    // Composite PK enforced.
    await expect(
      c.execute(
        `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES ('t1', 't2', ?)`,
        [now],
      ),
    ).rejects.toThrow()
  })

  it('converts task-adjacent operational timestamps to epoch milliseconds', async () => {
    const c = openDb(freshKey())
    try {
      await __execSchemaBatch(c, [
        `CREATE TABLE task_blockers (
          task_id text NOT NULL,
          blocker_task_id text NOT NULL,
          state text NOT NULL DEFAULT 'confirmed',
          provenance text NOT NULL DEFAULT 'inferred',
          created_at text NOT NULL,
          PRIMARY KEY (task_id, blocker_task_id)
        )`,
        `CREATE TABLE task_proposal_blockers (
          task_id text NOT NULL,
          proposal_id text NOT NULL,
          created_at text NOT NULL,
          PRIMARY KEY (task_id, proposal_id)
        )`,
        `CREATE TABLE task_acceptance (
          id text PRIMARY KEY,
          task_id text NOT NULL,
          position bigint NOT NULL,
          text text NOT NULL,
          status text NOT NULL DEFAULT 'pending',
          note text,
          updated_at text NOT NULL
        )`,
        `CREATE TABLE self_heal_attempts (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          parent_task_id text NOT NULL,
          failure_signature text NOT NULL,
          fix_task_id text NOT NULL,
          created_at text NOT NULL
        )`,
        `CREATE TABLE questions (
          id text PRIMARY KEY,
          task_id text NOT NULL,
          question text NOT NULL,
          rationale text,
          category text,
          answer text,
          status text NOT NULL DEFAULT 'open',
          created_at text NOT NULL
        )`,
        {
          sql: `INSERT INTO task_blockers VALUES ('task', 'blocker', 'confirmed', 'inferred', '1970-01-01T00:00:01.234Z')`,
        },
        {
          sql: `INSERT INTO task_proposal_blockers VALUES ('task', 'proposal', '1970-01-01T00:00:02.345Z')`,
        },
        {
          sql: `INSERT INTO task_acceptance VALUES ('acceptance', 'task', 1, 'works', 'pending', NULL, '1970-01-01T00:00:03.456Z')`,
        },
        {
          sql: `INSERT INTO self_heal_attempts (parent_task_id, failure_signature, fix_task_id, created_at)
                VALUES ('task', 'signature', 'fix', '1970-01-01T00:00:04.567Z')`,
        },
        {
          sql: `INSERT INTO questions (id, task_id, question, created_at)
                VALUES ('question', 'task', 'What now?', '1970-01-01T00:00:05.678Z')`,
        },
      ])

      await ensureSchema(c)

      expect((await columnsOf(c, 'task_blockers')).get('created_at')).toBe('bigint')
      expect((await columnsOf(c, 'task_proposal_blockers')).get('created_at')).toBe('bigint')
      expect((await columnsOf(c, 'task_acceptance')).get('updated_at')).toBe('bigint')
      expect((await columnsOf(c, 'self_heal_attempts')).get('created_at')).toBe('bigint')
      expect((await columnsOf(c, 'questions')).get('created_at')).toBe('bigint')
      expect((await c.execute(`SELECT created_at FROM task_blockers`)).rows[0].created_at).toBe(1234)
      expect((await c.execute(`SELECT created_at FROM task_proposal_blockers`)).rows[0].created_at).toBe(2345)
      expect((await c.execute(`SELECT updated_at FROM task_acceptance`)).rows[0].updated_at).toBe(3456)
      expect((await c.execute(`SELECT created_at FROM self_heal_attempts`)).rows[0].created_at).toBe(4567)
      expect((await c.execute(`SELECT created_at FROM questions`)).rows[0].created_at).toBe(5678)
    } finally {
      await c.close()
    }
  })

  it('tasks.status CHECK rejects unknown statuses', async () => {
    const c = await freshSchemaClient()
    const now = new Date().toISOString()
    await expect(
      c.execute(
        `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
         VALUES ('t1', 'p', 'nonsense', ?, ?)`,
        [now, now],
      ),
    ).rejects.toThrow()
  })

  it('action_queue_items has the full ALTER-era columns; history "by" is quoted', async () => {
    const c = await freshSchemaClient()
    const cols = await columnsOf(c, 'action_queue_items')
    for (const name of [
      'id', 'kind', 'category', 'priority', 'state', 'title', 'body',
      'payload', 'context', 'raised_by', 'raised_at', 'resolved_at',
      'resolution', 'resolution_note', 'root_cause', 'fingerprint',
      'signature', 'seen_count', 'last_seen_at', 'resolved_by',
      'origin_task_id', 'snoozed_until',
    ]) {
      expect(cols.has(name), `action_queue_items.${name} missing`).toBe(true)
    }
    const hist = await columnsOf(c, 'action_queue_history')
    expect(hist.has('by')).toBe(true)
    await c.execute(
      `INSERT INTO action_queue_items (id, kind, category, priority, title, raised_by, raised_at)
       VALUES ('i1', 'k', 'c', 'high', 'T', 'daemon', ?)`,
      [Date.now()],
    )
    await c.execute(
      `INSERT INTO action_queue_history (id, item_id, at, to_state, "by")
       VALUES ('h1', 'i1', ?, 'open', 'operator')`,
      [Date.now()],
    )
    const r = await c.execute(`SELECT "by" FROM action_queue_history WHERE id = 'h1'`)
    expect(r.rows[0].by).toBe('operator')
  })

  it('uses bigint epoch milliseconds for action-queue operational timestamps', async () => {
    const c = await freshSchemaClient()

    const taskProgress = await columnsOf(c, 'task_progress')
    const taskTranscripts = await columnsOf(c, 'task_transcripts')
    const durableTranscripts = await columnsOf(c, 'task_durable_transcripts')
    const actionQueue = await columnsOf(c, 'action_queue_items')
    const actionQueueHistory = await columnsOf(c, 'action_queue_history')
    const failureStreak = await columnsOf(c, 'failure_signature_streak')
    const mergeJobs = await columnsOf(c, 'merge_jobs')

    expect(taskProgress.get('created_at')).toBe('bigint')
    expect(taskTranscripts.get('ts')).toBe('bigint')
    expect(durableTranscripts.get('created_at')).toBe('bigint')
    for (const column of ['raised_at', 'resolved_at', 'last_seen_at', 'snoozed_until']) {
      expect(actionQueue.get(column), `action_queue_items.${column}`).toBe('bigint')
    }
    expect(actionQueueHistory.get('at')).toBe('bigint')
    expect(failureStreak.get('updated_at')).toBe('timestamp with time zone')
    for (const column of ['claimed_at', 'started_at', 'finished_at', 'created_at', 'updated_at']) {
      expect(mergeJobs.get(column), `merge_jobs.${column}`).toBe('timestamp with time zone')
    }
  })

  it('ports the partial and DESC indexes', async () => {
    const c = await freshSchemaClient()
    const r = await c.execute(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    )
    const defs = new Map(
      r.rows.map((row) => [row.indexname as string, row.indexdef as string]),
    )
    for (const name of [
      'idx_tasks_priority_created', 'idx_tasks_fix_for', 'idx_tasks_kind',
      'idx_tasks_origin_id', 'idx_tasks_parent_proposal_id',
      'idx_tasks_followup_dedup_key', 'idx_task_blockers_task',
      'idx_task_blockers_blocker', 'idx_task_blockers_task_state',
      'idx_trace_events_task_time', 'idx_trace_events_time_desc',
      'idx_trace_events_origin_time', 'idx_trace_events_step_ended_time',
      'idx_proposals_fingerprint', 'idx_scorer_results_scorer_task',
      'idx_promotion_ledger_workflow', 'idx_memory_packets_domain_salience',
      'idx_action_queue_fingerprint_state', 'idx_action_queue_state',
      'idx_action_queue_open_snoozed_until',
      'idx_action_queue_history_item', 'idx_kpi_snapshots_taken_at',
      'idx_self_heal_attempts_parent_signature',
      'idx_self_heal_attempts_fix_task', 'idx_tool_promotion_status',
    ]) {
      expect(defs.has(name), `index ${name} missing`).toBe(true)
    }
    expect(defs.get('idx_proposals_fingerprint')).toContain('IS NOT NULL')
    expect(defs.get('idx_trace_events_step_ended_time')).toContain('step_ended')
    expect(defs.get('idx_trace_events_time_desc')).toContain('DESC')
    expect(defs.get('idx_tasks_priority_created')).toContain('priority DESC')
    expect(defs.get('idx_scorer_results_scorer_task')).toContain('UNIQUE')
  })

  it('cascading FKs behave (proposal delete collapses its dispatch gates)', async () => {
    const c = await freshSchemaClient()
    const now = new Date().toISOString()
    await c.execute(
      `INSERT INTO proposals (id, created_at, updated_at) VALUES ('p1', 1, 1)`,
    )
    await c.execute(
      `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
       VALUES ('t1', 'p', 'queued', ?, ?)`,
      [now, now],
    )
    await c.execute(
      `INSERT INTO task_proposal_blockers (task_id, proposal_id, created_at)
       VALUES ('t1', 'p1', ?)`,
      [Date.now()],
    )
    await c.execute(`DELETE FROM proposals WHERE id = 'p1'`)
    const r = await c.execute(`SELECT count(*) AS n FROM task_proposal_blockers`)
    expect(r.rows[0].n).toBe(0)
  })

  it('task_durable_transcripts round-trips a bytea transcript', async () => {
    const c = await freshSchemaClient()
    const blob = new Uint8Array([0x1f, 0x8b, 0, 255, 42])
    await c.execute(
      `INSERT INTO task_durable_transcripts (task_id, created_at, transcript, byte_len)
       VALUES ('t1', ?, ?, ?)`,
      [Date.now(), blob, blob.byteLength],
    )
    const r = await c.execute(
      `SELECT transcript, byte_len FROM task_durable_transcripts WHERE task_id = 't1'`,
    )
    const out = r.rows[0].transcript as Uint8Array
    expect(Array.from(out)).toEqual(Array.from(blob))
    expect(r.rows[0].byte_len).toBe(5)
    expect((await columnsOf(c, 'task_durable_transcripts')).get('created_at')).toBe('bigint')
  })

  it('converts legacy progress and transcript timestamps to epoch milliseconds', async () => {
    const c = await freshSchemaClient()
    try {
      await c.execute(
        `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
         VALUES ('timestamp-task', 'p', 'queued', now(), now())`,
      )
      await __execSchemaBatch(c, [
        `ALTER TABLE task_progress ALTER COLUMN created_at TYPE text USING created_at::text`,
        `ALTER TABLE task_transcripts ALTER COLUMN ts TYPE text USING ts::text`,
        `ALTER TABLE task_durable_transcripts ALTER COLUMN created_at TYPE text USING created_at::text`,
        {
          sql: `INSERT INTO task_progress (id, task_id, created_at, author, kind, body)
                VALUES ('legacy-progress', 'timestamp-task', '1970-01-01T00:00:01.234Z', 'agent', 'note', 'legacy')`,
        },
        {
          sql: `INSERT INTO task_transcripts (task_id, session_id, seq, chunk, ts)
                VALUES ('timestamp-task', 'session', 0, '[]', '1970-01-01T00:00:02.345Z')`,
        },
        {
          sql: `INSERT INTO task_durable_transcripts (task_id, created_at, transcript, byte_len)
                VALUES ('timestamp-task', '1970-01-01T00:00:03.456Z', ?, 1)`,
          args: [new Uint8Array([0])],
        },
      ])

      await ensureSchema(c)

      expect((await c.execute(`SELECT created_at FROM task_progress WHERE id = 'legacy-progress'`)).rows[0].created_at).toBe(1234)
      expect((await c.execute(`SELECT ts FROM task_transcripts WHERE task_id = 'timestamp-task'`)).rows[0].ts).toBe(2345)
      expect((await c.execute(`SELECT created_at FROM task_durable_transcripts WHERE task_id = 'timestamp-task'`)).rows[0].created_at).toBe(3456)
    } finally {
      await c.close()
    }
  })

  it('IDENTITY_COLUMNS matches the identity columns in the live schema', async () => {
    const c = await freshSchemaClient()
    const r = await c.execute(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND is_identity = 'YES'`,
    )
    const live = Object.fromEntries(
      r.rows.map((row) => [row.table_name as string, row.column_name as string]),
    )
    expect(live).toEqual(IDENTITY_COLUMNS)
  })
})
