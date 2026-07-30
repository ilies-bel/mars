import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'

import { openDb } from '../lib/db.js'
import { ensureSchema, SCHEMA_VERSION } from '../lib/pg-schema.js'

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
