import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@libsql/client'
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-merge-db-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const seedQueue = async (path: string): Promise<void> => {
  const c = createClient({ url: `file:${path}` })
  await c.execute(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  await c.execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
          VALUES ('t-legacy', 'legacy task', 'queued', 'now', 'now')`,
    args: [],
  })
  c.close()
}

const seedState = async (path: string): Promise<void> => {
  const c = createClient({ url: `file:${path}` })
  await c.execute(`CREATE TABLE proposals (
    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft', source TEXT NOT NULL DEFAULT 'human',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`)
  await c.execute({
    sql: `INSERT INTO proposals (id, title, created_at, updated_at)
          VALUES ('p-legacy', 'legacy proposal', 0, 0)`,
    args: [],
  })
  c.close()
}

const countRows = async (path: string, table: string): Promise<number> => {
  const c = createClient({ url: `file:${path}` })
  const r = await c.execute(`SELECT COUNT(*) AS n FROM "${table}"`)
  c.close()
  return Number((r.rows[0] as unknown as { n: number }).n)
}

describe('mergeLegacyDatabases', () => {
  let repo: string
  let queuePath: string
  let statePath: string
  let marsPath: string

  beforeEach(() => {
    repo = setupRepo()
    queuePath = resolve(repo, '.mars/queue.db')
    statePath = resolve(repo, '.mars/state.db')
    marsPath = resolve(repo, '.mars/mars.db')
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('folds legacy queue.db + state.db into mars.db and deletes the legacy files', async () => {
    await seedQueue(queuePath)
    await seedState(statePath)

    const { mergeLegacyDatabases } = await import('./merge-databases')
    await mergeLegacyDatabases()

    expect(await countRows(marsPath, 'tasks')).toBe(1)
    expect(await countRows(marsPath, 'proposals')).toBe(1)
    expect(existsSync(queuePath)).toBe(false)
    expect(existsSync(statePath)).toBe(false)
  })

  it('does NOT skip when an empty mars.db already exists (the regression)', async () => {
    await seedQueue(queuePath)
    await seedState(statePath)
    // Materialise an empty mars.db, the way a stray client open would —
    // the old sentinel keyed off existsSync(mars.db) and skipped here,
    // stranding the legacy data forever.
    const empty = createClient({ url: `file:${marsPath}` })
    await empty.execute('SELECT 1')
    empty.close()
    expect(existsSync(marsPath)).toBe(true)

    const { mergeLegacyDatabases } = await import('./merge-databases')
    await mergeLegacyDatabases()

    expect(await countRows(marsPath, 'tasks')).toBe(1)
    expect(await countRows(marsPath, 'proposals')).toBe(1)
    expect(existsSync(queuePath)).toBe(false)
    expect(existsSync(statePath)).toBe(false)
  })

  it('preserves pre-existing mars.db rows on id collision (INSERT OR IGNORE)', async () => {
    await seedQueue(queuePath)
    // mars.db already has a task with the SAME id but a newer status —
    // the merge must NOT clobber it with the legacy row.
    const m = createClient({ url: `file:${marsPath}` })
    await m.execute(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    await m.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES ('t-legacy', 'legacy task', 'failed', 'now', 'newer')`,
      args: [],
    })
    m.close()

    const { mergeLegacyDatabases } = await import('./merge-databases')
    await mergeLegacyDatabases()

    const c = createClient({ url: `file:${marsPath}` })
    const r = await c.execute(`SELECT status FROM tasks WHERE id = 't-legacy'`)
    c.close()
    expect((r.rows[0] as unknown as { status: string }).status).toBe('failed')
    expect(await countRows(marsPath, 'tasks')).toBe(1)
  })

  it('unlinks a 0-byte legacy file without touching mars.db', async () => {
    // A 0-byte file is left when a stray client open materialised the path
    // before any data was written — nothing to fold, just delete it.
    writeFileSync(queuePath, '')

    const { mergeLegacyDatabases } = await import('./merge-databases')
    await mergeLegacyDatabases()

    // The 0-byte file must be gone
    expect(existsSync(queuePath)).toBe(false)
    // No client was opened for mars.db, so no spurious tables were created
    expect(existsSync(marsPath)).toBe(false)
  })

  it('is a no-op once the legacy files are gone', async () => {
    // Fresh repo with only mars.db present.
    const m = createClient({ url: `file:${marsPath}` })
    await m.execute('SELECT 1')
    m.close()

    const { mergeLegacyDatabases } = await import('./merge-databases')
    await expect(mergeLegacyDatabases()).resolves.toBeUndefined()
  })
})
