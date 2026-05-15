import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface IdeasModule {
  createIdea: typeof import('./ideas').createIdea
  getIdea: typeof import('./ideas').getIdea
  resolveIdeaId: typeof import('./ideas').resolveIdeaId
  initIdeas: typeof import('./ideas').initIdeas
  deleteIdea: typeof import('./ideas').deleteIdea
  addIdeaUserStory: typeof import('./ideas').addIdeaUserStory
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-ideas-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<IdeasModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('./ideas')) as unknown as IdeasModule
}

const insertIdea = async (
  ideas: IdeasModule,
  id: string,
  title: string,
): Promise<void> => {
  await ideas.initIdeas()
  // The createIdea path generates random ids; we need deterministic ids that
  // share a prefix, so insert directly via a fresh client.
  const { createClient } = await import('@libsql/client')
  const c = createClient({ url: `file:${process.env.MARS_REPO}/.mars/state.db` })
  const now = Date.now()
  await c.execute({
    sql: `INSERT INTO ideas (id, title, status, source, created_at, updated_at)
          VALUES (?, ?, 'draft', 'human', ?, ?)`,
    args: [id, title, now, now],
  })
  c.close()
}

describe('resolveIdeaId', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('exact-id lookup returns unique', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1234-foo', 'foo idea')
    await insertIdea(ideas, 'abcd5678-bar', 'bar idea')

    const r = await ideas.resolveIdeaId('abcd1234-foo')
    expect(r).toEqual({ kind: 'unique', id: 'abcd1234-foo' })
  })

  it('unique-prefix lookup returns the row', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1234-foo', 'foo idea')
    await insertIdea(ideas, 'wxyz9999-bar', 'bar idea')

    const r = await ideas.resolveIdeaId('abcd1234')
    expect(r).toEqual({ kind: 'unique', id: 'abcd1234-foo' })

    const idea = await ideas.getIdea('abcd1234')
    expect(idea?.id).toBe('abcd1234-foo')
    expect(idea?.title).toBe('foo idea')
  })

  it('ambiguous prefix returns ambiguous with count', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1111-one', 'one')
    await insertIdea(ideas, 'abcd2222-two', 'two')
    await insertIdea(ideas, 'abcd3333-three', 'three')

    const r = await ideas.resolveIdeaId('abcd')
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') {
      expect(r.count).toBe(3)
    }

    const idea = await ideas.getIdea('abcd')
    expect(idea).toBeNull()
  })

  it('non-matching prefix returns none', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1234-foo', 'foo')

    const r = await ideas.resolveIdeaId('zzzz9999')
    expect(r).toEqual({ kind: 'none' })

    const idea = await ideas.getIdea('zzzz9999')
    expect(idea).toBeNull()
  })

  it('prefix shorter than 4 chars returns none even if it would match', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1234-foo', 'foo')

    const r = await ideas.resolveIdeaId('abc')
    expect(r).toEqual({ kind: 'none' })
  })

  it('exact match wins even when shorter than the 4-char threshold', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'xy', 'two-char id')

    const r = await ideas.resolveIdeaId('xy')
    expect(r).toEqual({ kind: 'unique', id: 'xy' })
  })
})

describe('ideas source column migration', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('source column is NOT NULL after init', async () => {
    const ideas = await loadModule(repo)
    await ideas.initIdeas()
    const { createClient } = await import('@libsql/client')
    const c = createClient({ url: `file:${repo}/.mars/state.db` })
    const cols = await c.execute(`PRAGMA table_info(ideas)`)
    c.close()
    const sourceCol = cols.rows
      .map((r) => r as unknown as { name: string; notnull: number })
      .find((r) => r.name === 'source')
    expect(sourceCol).toBeDefined()
    expect(sourceCol?.notnull).toBe(1)
  })

  it("backfills source='planner' for pre-existing rows authored by agents", async () => {
    // Simulate a pre-existing DB shape that has author_kind columns but no
    // source column. initIdeas should add the column AND backfill.
    const { createClient } = await import('@libsql/client')
    const c = createClient({ url: `file:${repo}/.mars/state.db` })
    await c.execute(`
      CREATE TABLE ideas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        author_kind TEXT,
        author_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    const now = Date.now()
    await c.execute({
      sql: `INSERT INTO ideas (id, title, author_kind, author_name, created_at, updated_at)
            VALUES (?, ?, 'agent', 'reflector', ?, ?)`,
      args: ['agent01-x', 'agent idea', now, now],
    })
    await c.execute({
      sql: `INSERT INTO ideas (id, title, author_kind, author_name, created_at, updated_at)
            VALUES (?, ?, 'human', 'alice', ?, ?)`,
      args: ['human01-x', 'human idea', now, now],
    })
    c.close()

    const ideas = await loadModule(repo)
    await ideas.initIdeas()

    const agentIdea = await ideas.getIdea('agent01-x')
    expect(agentIdea?.source).toBe('planner')
  })

  it("backfills source='human' for pre-existing rows authored by humans", async () => {
    const { createClient } = await import('@libsql/client')
    const c = createClient({ url: `file:${repo}/.mars/state.db` })
    await c.execute(`
      CREATE TABLE ideas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        author_kind TEXT,
        author_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    const now = Date.now()
    await c.execute({
      sql: `INSERT INTO ideas (id, title, author_kind, author_name, created_at, updated_at)
            VALUES (?, ?, 'human', 'alice', ?, ?)`,
      args: ['human01-x', 'human idea', now, now],
    })
    await c.execute({
      sql: `INSERT INTO ideas (id, title, author_kind, author_name, created_at, updated_at)
            VALUES (?, ?, NULL, NULL, ?, ?)`,
      args: ['nulla01-x', 'no author', now, now],
    })
    c.close()

    const ideas = await loadModule(repo)
    await ideas.initIdeas()

    const humanIdea = await ideas.getIdea('human01-x')
    expect(humanIdea?.source).toBe('human')
    const noAuthor = await ideas.getIdea('nulla01-x')
    expect(noAuthor?.source).toBe('human')
  })

  it('rejects createIdea with an invalid source value', async () => {
    const ideas = await loadModule(repo)
    await ideas.initIdeas()
    await expect(
      ideas.createIdea('bogus', {
        source: 'not-a-source' as unknown as 'human',
      }),
    ).rejects.toThrow(/source/i)
  })

  it('is idempotent — running initIdeas twice does not error or change backfilled values', async () => {
    const { createClient } = await import('@libsql/client')
    const c = createClient({ url: `file:${repo}/.mars/state.db` })
    await c.execute(`
      CREATE TABLE ideas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        author_kind TEXT,
        author_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    const now = Date.now()
    await c.execute({
      sql: `INSERT INTO ideas (id, title, author_kind, author_name, created_at, updated_at)
            VALUES (?, ?, 'agent', 'reflector', ?, ?)`,
      args: ['agent01-x', 'agent idea', now, now],
    })
    c.close()

    const first = await loadModule(repo)
    await first.initIdeas()
    // Flip the source manually to confirm the second run doesn't clobber it
    // back to 'planner' (i.e. backfill must not run twice).
    const c2 = createClient({ url: `file:${repo}/.mars/state.db` })
    await c2.execute({
      sql: `UPDATE ideas SET source = 'human' WHERE id = 'agent01-x'`,
      args: [],
    })
    c2.close()

    const second = await loadModule(repo)
    await expect(second.initIdeas()).resolves.not.toThrow()
    const idea = await second.getIdea('agent01-x')
    expect(idea?.source).toBe('human')
  })
})

describe('deleteIdea', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('removes an existing idea by exact id', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1234-foo', 'foo')

    const removed = await ideas.deleteIdea('abcd1234-foo')
    expect(removed).toBe('abcd1234-foo')
    expect(await ideas.getIdea('abcd1234-foo')).toBeNull()
  })

  it('removes an idea matched by unique prefix', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1234-foo', 'foo')
    await insertIdea(ideas, 'wxyz9999-bar', 'bar')

    const removed = await ideas.deleteIdea('abcd1234')
    expect(removed).toBe('abcd1234-foo')
    expect(await ideas.getIdea('abcd1234-foo')).toBeNull()
    expect(await ideas.getIdea('wxyz9999-bar')).not.toBeNull()
  })

  it('cascades user-story rows', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1234-foo', 'foo')
    await ideas.addIdeaUserStory('abcd1234-foo', 'as a user, I delete')

    await ideas.deleteIdea('abcd1234-foo')

    const { createClient } = await import('@libsql/client')
    const c = createClient({
      url: `file:${process.env.MARS_REPO}/.mars/state.db`,
    })
    const r = await c.execute({
      sql: `SELECT COUNT(*) AS n FROM idea_user_stories WHERE idea_id = ?`,
      args: ['abcd1234-foo'],
    })
    c.close()
    const n = Number(
      (r.rows[0] as unknown as { n: number | bigint }).n ?? 0,
    )
    expect(n).toBe(0)
  })

  it('throws on unknown id', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1234-foo', 'foo')

    await expect(ideas.deleteIdea('zzzz9999')).rejects.toThrow(
      /not found/,
    )
  })

  it('throws on ambiguous prefix without deleting anything', async () => {
    const ideas = await loadModule(repo)
    await insertIdea(ideas, 'abcd1111-one', 'one')
    await insertIdea(ideas, 'abcd2222-two', 'two')

    await expect(ideas.deleteIdea('abcd')).rejects.toThrow(/ambiguous/)
    expect(await ideas.getIdea('abcd1111-one')).not.toBeNull()
    expect(await ideas.getIdea('abcd2222-two')).not.toBeNull()
  })
})
