import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createClient } from '@libsql/client'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-origin-id-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../../queue')
  await mod.migrateQueueSchema()
  return mod
}

describe('queue.origin_id migration', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('migrateQueueSchema is idempotent: running twice does not duplicate the column', async () => {
    const q = await loadQueue(repo)
    await q.migrateQueueSchema()
    await q.migrateQueueSchema()

    const dbPath = resolve(repo, '.mars/mars.db')
    const direct = createClient({ url: `file:${dbPath}` })
    const cols = await direct.execute(`PRAGMA table_info(tasks)`)
    const originIdCols = cols.rows.filter(
      (r) => (r as unknown as { name: string }).name === 'origin_id',
    )
    expect(originIdCols).toHaveLength(1)
  })

  it('new tasks get origin_id = id by default (direct mars task add)', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    expect(t.originId).toBe(t.id)

    const dbPath = resolve(repo, '.mars/mars.db')
    const direct = createClient({ url: `file:${dbPath}` })
    const r = await direct.execute({
      sql: `SELECT origin_id FROM tasks WHERE id = ?`,
      args: [t.id],
    })
    expect((r.rows[0] as unknown as { origin_id: string }).origin_id).toBe(t.id)
  })

  it('enqueueTask honours explicit originId option (idea-originated tasks)', async () => {
    const q = await loadQueue(repo)
    const ideaId = 'idea-abc-12345678'
    const t = await q.enqueueTask('from idea', undefined, {
      skipTriage: true,
      originId: ideaId,
    })
    expect(t.originId).toBe(ideaId)
  })

  it('backfills origin_id on legacy rows (column added on stale DB → origin_id = id)', async () => {
    // Simulate a pre-migration DB by creating tasks WITHOUT origin_id and
    // dropping the column before migrateQueueSchema runs the migration.
    const dbPath = resolve(repo, '.mars/mars.db')
    const direct = createClient({ url: `file:${dbPath}` })
    const now = new Date().toISOString()
    // Mimic the legacy schema (no origin_id column).
    await direct.execute(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    await direct.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: ['legacy01', 'old', 'queued', now, now],
    })
    // Now run migrateQueueSchema which should migrate + backfill.
    const q = await loadQueue(repo)
    void q
    const r = await direct.execute({
      sql: `SELECT origin_id FROM tasks WHERE id = ?`,
      args: ['legacy01'],
    })
    expect((r.rows[0] as unknown as { origin_id: string }).origin_id).toBe(
      'legacy01',
    )
  })
})
