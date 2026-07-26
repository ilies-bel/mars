import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { __resetDbRegistryForTests, openDb, type DbClient } from './db.js'
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
      'verify_cmd', 'preview_cmd', 'dev_server_url', 'dev_server_pid',
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
    expect(cols.get('created_at')).toBe('text') // ISO-8601 stays text (0002 §4)
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

  it('task_blockers keeps state CHECK, provenance, and composite PK', async () => {
    const c = await freshSchemaClient()
    const cols = await columnsOf(c, 'task_blockers')
    expect(cols.get('provenance')).toBe('text')
    const now = new Date().toISOString()
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
      [new Date().toISOString()],
    )
    await c.execute(
      `INSERT INTO action_queue_history (id, item_id, at, to_state, "by")
       VALUES ('h1', 'i1', ?, 'open', 'operator')`,
      [new Date().toISOString()],
    )
    const r = await c.execute(`SELECT "by" FROM action_queue_history WHERE id = 'h1'`)
    expect(r.rows[0].by).toBe('operator')
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
      [now],
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
      [new Date().toISOString(), blob, blob.byteLength],
    )
    const r = await c.execute(
      `SELECT transcript, byte_len FROM task_durable_transcripts WHERE task_id = 't1'`,
    )
    const out = r.rows[0].transcript as Uint8Array
    expect(Array.from(out)).toEqual(Array.from(blob))
    expect(r.rows[0].byte_len).toBe(5)
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
