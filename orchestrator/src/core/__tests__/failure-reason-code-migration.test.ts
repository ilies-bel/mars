/**
 * Tests for the `tasks.failure_reason_code` column migration introduced in
 * slice D. The column is added idempotently — running `migrateQueueSchema` twice (or
 * starting two daemons against the same `mars.db`) must not error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@libsql/client'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-fr-code-mig-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('failure_reason_code migration', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('adds the failure_reason_code column to a fresh tasks table', async () => {
    const { migrateQueueSchema } = await import('../queue')
    await migrateQueueSchema()

    const q = createClient({ url: `file:${repo}/.mars/mars.db` })
    const cols = await q.execute(`PRAGMA table_info(tasks)`)
    const colNames = (cols.rows as unknown as Array<{ name: string }>).map((r) => r.name)
    expect(colNames).toContain('failure_reason_code')
    // Legacy column stays — slice D explicitly keeps it for forensic continuity.
    expect(colNames).toContain('failure_reason')
    q.close()
  })

  it('is idempotent: running migrateQueueSchema twice does not error', async () => {
    const { migrateQueueSchema } = await import('../queue')
    await migrateQueueSchema()
    // Second run must be a no-op for already-applied migrations.
    await expect(migrateQueueSchema()).resolves.not.toThrow()

    const q = createClient({ url: `file:${repo}/.mars/mars.db` })
    const cols = await q.execute(`PRAGMA table_info(tasks)`)
    const colNames = (cols.rows as unknown as Array<{ name: string }>).map((r) => r.name)
    // Count of failure_reason_code occurrences must be exactly 1 (no duplicate
    // ALTERs).
    expect(colNames.filter((n) => n === 'failure_reason_code')).toHaveLength(1)
    q.close()
  })

  it('migrates a legacy DB that has no failure_reason_code column', async () => {
    // Seed a legacy tasks table without the new column.
    const queueDb = `file:${repo}/.mars/mars.db`
    const q = createClient({ url: queueDb })
    await q.execute(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
      origin_id TEXT, recovery_spawned_count INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    const now = new Date().toISOString()
    await q.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, failure_reason, created_at, updated_at)
            VALUES ('legacy', 'old task', 'failed', 'legacy', 0, 'verify:test/unclassified', ?, ?)`,
      args: [now, now],
    })
    q.close()

    const { migrateQueueSchema } = await import('../queue')
    await migrateQueueSchema()

    // Column is present; existing rows have NULL in the new column; the
    // legacy `failure_reason` is preserved verbatim.
    const q2 = createClient({ url: queueDb })
    const cols = await q2.execute(`PRAGMA table_info(tasks)`)
    const colNames = (cols.rows as unknown as Array<{ name: string }>).map((r) => r.name)
    expect(colNames).toContain('failure_reason_code')

    const row = await q2.execute(
      `SELECT failure_reason, failure_reason_code FROM tasks WHERE id = 'legacy'`,
    )
    const r = row.rows[0] as unknown as {
      failure_reason: string | null
      failure_reason_code: string | null
    }
    expect(r.failure_reason).toBe('verify:test/unclassified')
    expect(r.failure_reason_code).toBeNull()
    q2.close()
  })
})
