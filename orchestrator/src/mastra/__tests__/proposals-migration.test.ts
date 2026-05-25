import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@libsql/client'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-prop-mig-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const tableNames = async (url: string): Promise<Set<string>> => {
  const c = createClient({ url })
  const r = await c.execute(
    `SELECT name FROM sqlite_master WHERE type='table'`,
  )
  c.close()
  return new Set(
    (r.rows as unknown as Array<{ name: string }>).map((x) => x.name),
  )
}

const columnNames = async (
  url: string,
  table: string,
): Promise<Set<string>> => {
  const c = createClient({ url })
  const r = await c.execute(`PRAGMA table_info(${table})`)
  c.close()
  return new Set(
    (r.rows as unknown as Array<{ name: string }>).map((x) => x.name),
  )
}

describe('ideas -> proposals schema migration on startup', () => {
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

  it('renames a legacy ideas table to proposals with no ideas table left', async () => {
    const stateDb = `file:${repo}/.mars/mars.db`
    const queueDb = `file:${repo}/.mars/mars.db`

    const s = createClient({ url: stateDb })
    await s.execute(`CREATE TABLE ideas (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'human',
      author_kind TEXT, author_name TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`)
    await s.execute(`CREATE TABLE idea_user_stories (
      idea_id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY(idea_id, position),
      FOREIGN KEY(idea_id) REFERENCES ideas(id) ON DELETE CASCADE
    )`)
    const now = Date.now()
    await s.execute({
      sql: `INSERT INTO ideas (id, title, created_at, updated_at) VALUES ('keep01-x', 'survivor', ?, ?)`,
      args: [now, now],
    })
    await s.execute({
      sql: `INSERT INTO idea_user_stories (idea_id, position, text) VALUES ('keep01-x', 0, 'as a user')`,
      args: [],
    })
    s.close()

    // Legacy queue.db with a parent_idea_id column on tasks.
    const q = createClient({ url: queueDb })
    await q.execute(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
      origin_id TEXT, parent_idea_id TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    q.close()

    const { initProposals } = await import('../proposals')
    await initProposals()

    const stateTables = await tableNames(stateDb)
    expect(stateTables.has('proposals')).toBe(true)
    expect(stateTables.has('ideas')).toBe(false)
    expect(stateTables.has('proposal_user_stories')).toBe(true)
    expect(stateTables.has('idea_user_stories')).toBe(false)

    const usCols = await columnNames(stateDb, 'proposal_user_stories')
    expect(usCols.has('proposal_id')).toBe(true)
    expect(usCols.has('idea_id')).toBe(false)

    const taskCols = await columnNames(queueDb, 'tasks')
    expect(taskCols.has('parent_proposal_id')).toBe(true)
    expect(taskCols.has('parent_idea_id')).toBe(false)

    // The pre-existing row survives the rename.
    const s2 = createClient({ url: stateDb })
    const rows = await s2.execute(`SELECT id, title FROM proposals`)
    s2.close()
    expect(rows.rows).toHaveLength(1)
    expect((rows.rows[0] as unknown as { id: string }).id).toBe('keep01-x')
  })

  it('creates a proposals table directly on a fresh repo', async () => {
    const stateDb = `file:${repo}/.mars/mars.db`
    const { initProposals } = await import('../proposals')
    await initProposals()

    const stateTables = await tableNames(stateDb)
    expect(stateTables.has('proposals')).toBe(true)
    expect(stateTables.has('ideas')).toBe(false)
    expect(stateTables.has('proposal_user_stories')).toBe(true)
  })
})
