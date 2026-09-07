import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'

import { openDb } from '../lib/db.js'
import { DDL_HASH, ensureSchema } from '../lib/pg-schema.js'
import { loadVerifyGates } from '../verify-gates.js'

describe('migration 0002 PostgreSQL cutover', () => {
  it('boots the canonical schema and records the PostgreSQL migration version', async () => {
    const db = openDb(`pglite://migration-cutover-${randomUUID()}`)
    try {
      await ensureSchema(db)
      const version = await db.execute({
        sql: 'SELECT version FROM schema_migrations WHERE version = ?',
        args: [DDL_HASH],
      })
      const tables = await db.execute(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name IN ('tasks', 'events', 'trace_events')`,
      )

      expect(version.rows).toHaveLength(1)
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
        'events',
        'tasks',
        'trace_events',
      ])
    } finally {
      await db.close()
    }
  })

  it('migrates timeout_min into an existing verify_gates table on the first post-7091bbcc boot', async () => {
    // Regression for "column timeout_min does not exist": ensureSchema
    // (= runCompositionRootMigrations) must add the column before any
    // verify_gates SELECT runs on a daemon restarted against a pre-7091bbcc DB.
    //
    // Simulates an existing install: run ensureSchema to get a full schema,
    // then roll the schema_migrations version back to an old value and drop the
    // column; the next ensureSchema (simulating a daemon restart on the new
    // binary) sees the old version → runs the full DDL → re-adds the column.
    const db = openDb(`pglite://verify-gates-timeout-min-${randomUUID()}`)
    try {
      // 1. Bootstrap the full schema (all tables + DDL_HASH recorded).
      await ensureSchema(db)

      // 2. Simulate an old install: remove the current schema version and drop
      //    the column to reproduce the state before timeout_min was added.
      await db.execute({
        sql: `DELETE FROM schema_migrations WHERE version = ?`,
        args: [DDL_HASH],
      })
      await db.execute(`ALTER TABLE verify_gates DROP COLUMN timeout_min`)
      await db.execute({
        sql: `INSERT INTO verify_gates
                (id, scope, name, cmd, args_json, required, tier, source, created_at, state)
              VALUES (?, '.', 'typecheck', 'npx', '["tsc"]', 1, 'task', 'human', ?, 'active')`,
        args: ['gate-pre-migration', 1000],
      })

      // 3. Daemon restarts — runCompositionRootMigrations calls ensureSchema.
      //    DDL_HASH is NOT in schema_migrations → full DDL runs → adds timeout_min.
      await ensureSchema(db)

      // 4. First gate read after boot — must not throw
      //    "column timeout_min does not exist".
      const scopes = await loadVerifyGates(db)
      expect(scopes).toHaveLength(1)
      expect(scopes[0].steps[0]).toMatchObject({
        name: 'typecheck',
        cmd: 'npx',
      })
      // Column was added with no DEFAULT — NULL → undefined in VerifyScope.
      expect(scopes[0].steps[0].timeoutMin).toBeUndefined()
    } finally {
      await db.close()
    }
  })

  it('migrates evidence into an existing verify_gates table on the first post-0039 boot', async () => {
    // Regression for "column evidence does not exist": ensureSchema
    // (= runCompositionRootMigrations) must add the column before any
    // verify_gates SELECT runs on a daemon restarted against a pre-0039 DB.
    //
    // Simulates a schema-0038 install: run ensureSchema, roll the version back
    // to '0038', and drop the evidence column. The next ensureSchema (the new
    // binary with DDL_HASH = '0039') runs the full DDL and re-adds it.
    const db = openDb(`pglite://verify-gates-evidence-${randomUUID()}`)
    try {
      // 1. Bootstrap the full schema.
      await ensureSchema(db)

      // 2. Simulate a pre-0039 install: roll back to version '0038' and drop
      //    the evidence column to reproduce the state before it was added.
      await db.execute({
        sql: `DELETE FROM schema_migrations WHERE version = ?`,
        args: [DDL_HASH],
      })
      await db.execute(`ALTER TABLE verify_gates DROP COLUMN evidence`)
      await db.execute({
        sql: `INSERT INTO verify_gates
                (id, scope, name, cmd, args_json, required, tier, source, created_at, state)
              VALUES (?, '.', 'lint', 'npm', '["run","lint"]', 1, 'task', 'human', ?, 'active')`,
        args: ['gate-pre-evidence', 1000],
      })

      // 3. Daemon restarts — runCompositionRootMigrations calls ensureSchema.
      //    DDL_HASH ('0039') is NOT in schema_migrations → full DDL runs → adds evidence.
      await ensureSchema(db)

      // 4. First gate read after boot — must not throw
      //    "column evidence does not exist".
      const scopes = await loadVerifyGates(db)
      expect(scopes).toHaveLength(1)
      expect(scopes[0].steps[0]).toMatchObject({
        name: 'lint',
        cmd: 'npm',
      })
    } finally {
      await db.close()
    }
  })

  it('runs the orchestrator/test required=0 data migration on daemon start (schema 0040)', async () => {
    // Regression: the migration was placed in ensureVerifyGatesSchema, which is
    // only called by `mars init`. On every EXISTING repo the migration was
    // dead code — it ran only against a brand-new database created by `mars
    // init`, never via runCompositionRootMigrations → ensureSchema.
    //
    // This test asserts the migration is reachable from the daemon's startup
    // path specifically.  It simulates an existing install that already has the
    // gate row (required=1) and has NOT yet applied schema 0040.
    const db = openDb(`pglite://verify-gates-required-migration-${randomUUID()}`)
    try {
      // 1. Bootstrap the full schema (all tables + DDL_HASH recorded).
      await ensureSchema(db)

      // 2. Insert the matching gate row as an existing install would have it.
      await db.execute({
        sql: `INSERT INTO verify_gates
                (id, scope, name, cmd, args_json, required, tier, source, created_at, state, timeout_min)
              VALUES (?, 'orchestrator', 'test', 'npm', '["test"]', 1, 'integration', 'human', ?, 'active', 20)`,
        args: ['gate-orch-test', 1000],
      })

      // 3. Confirm the row exists with required=1 before the migration runs.
      const before = await db.execute(
        `SELECT required FROM verify_gates WHERE scope = 'orchestrator' AND name = 'test'`,
      )
      expect(before.rows[0]).toMatchObject({ required: 1 })

      // 4. Simulate the daemon restarting with the new binary (schema 0040
      //    not yet recorded): remove DDL_HASH from schema_migrations so
      //    ensureSchema runs the full DDL batch again.
      await db.execute({
        sql: `DELETE FROM schema_migrations WHERE version = ?`,
        args: [DDL_HASH],
      })

      // 5. Daemon startup: runCompositionRootMigrations calls ensureSchema.
      //    DDL_HASH is NOT in schema_migrations → full DDL runs → data
      //    migration sets required = 0 for the matching gate.
      await ensureSchema(db)

      // 6. The gate must now have required=0.
      const after = await db.execute(
        `SELECT required FROM verify_gates WHERE scope = 'orchestrator' AND name = 'test'`,
      )
      expect(after.rows[0]).toMatchObject({ required: 0 })
    } finally {
      await db.close()
    }
  })

  it('supports time-window task queries without callers casting updated_at', async () => {
    const db = openDb(`pglite://task-timestamp-range-${randomUUID()}`)
    try {
      await ensureSchema(db)
      await db.execute({
        sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
              VALUES
                ('recent-task', 'recent', 'queued', now() - interval '5 minutes', now() - interval '5 minutes'),
                ('old-task', 'old', 'queued', now() - interval '2 days', now() - interval '2 days')`,
      })

      const result = await db.execute(
        `SELECT id FROM tasks
         WHERE updated_at > now() - interval '1 day'
         ORDER BY id`,
      )

      expect(result.rows.map((row) => row.id)).toEqual(['recent-task'])
    } finally {
      await db.close()
    }
  })
})
