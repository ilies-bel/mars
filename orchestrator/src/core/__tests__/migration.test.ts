import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'

import { openDb } from '../lib/db.js'
import { ensureSchema, SCHEMA_VERSION } from '../lib/pg-schema.js'
import { loadVerifyGates } from '../verify-gates.js'

describe('migration 0002 PostgreSQL cutover', () => {
  it('boots the canonical schema and records the PostgreSQL migration version', async () => {
    const db = openDb(`pglite://migration-cutover-${randomUUID()}`)
    try {
      await ensureSchema(db)
      const version = await db.execute({
        sql: 'SELECT version FROM schema_migrations WHERE version = ?',
        args: [SCHEMA_VERSION],
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
    const db = openDb(`pglite://verify-gates-timeout-min-${randomUUID()}`)
    try {
      // 1. Set up a known-good schema (ensureSchema is idempotent).
      await ensureSchema(db)

      // 2. Roll back to the pre-7091bbcc state by dropping the column.
      //    This is the on-disk condition that triggered the production failure.
      await db.execute(`ALTER TABLE verify_gates DROP COLUMN timeout_min`)
      await db.execute({
        sql: `INSERT INTO verify_gates
                (id, scope, name, cmd, args_json, required, tier, source, created_at, state)
              VALUES (?, '.', 'typecheck', 'npx', '["tsc"]', 1, 'task', 'human', ?, 'active')`,
        args: ['gate-pre-migration', 1000],
      })

      // 3. Daemon restarts — runCompositionRootMigrations calls ensureSchema.
      //    This must re-add timeout_min before any verify_gates SELECT fires.
      await ensureSchema(db)

      // 4. First gate read after boot — must not throw
      //    "column timeout_min does not exist".
      const scopes = await loadVerifyGates(db)
      expect(scopes).toHaveLength(1)
      expect(scopes[0].steps[0]).toMatchObject({
        name: 'typecheck',
        cmd: 'npx',
      })
      // Column was re-added with no DEFAULT — NULL → undefined in VerifyScope.
      expect(scopes[0].steps[0].timeoutMin).toBeUndefined()
    } finally {
      await db.close()
    }
  })

  it('migrates evidence into an existing verify_gates table on the first post-0039 boot', async () => {
    // Regression for "column evidence does not exist": ensureSchema
    // (= runCompositionRootMigrations) must add the column before any
    // verify_gates SELECT runs on a daemon restarted against a pre-0039 DB.
    const db = openDb(`pglite://verify-gates-evidence-${randomUUID()}`)
    try {
      // 1. Set up a known-good schema (ensureSchema is idempotent).
      await ensureSchema(db)

      // 2. Roll back to the pre-0039 state by dropping the column.
      //    This is the on-disk condition that triggered the production failure.
      await db.execute(`ALTER TABLE verify_gates DROP COLUMN evidence`)
      await db.execute({
        sql: `INSERT INTO verify_gates
                (id, scope, name, cmd, args_json, required, tier, source, created_at, state)
              VALUES (?, '.', 'lint', 'npm', '["run","lint"]', 1, 'task', 'human', ?, 'active')`,
        args: ['gate-pre-evidence', 1000],
      })

      // 3. Daemon restarts — runCompositionRootMigrations calls ensureSchema.
      //    This must re-add evidence before any verify_gates SELECT fires.
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
