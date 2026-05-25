import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'

import { startServer } from './index.ts'

interface InboxItemBody {
  id: string
  status: string
  source: 'draft' | 'blocked' | 'failed'
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-inbox-items-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const createQueueSchema = async (path: string): Promise<Client> => {
  const c = createClient({ url: `file:${path}` })
  await c.execute(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_functional TEXT,
    plan_technical TEXT,
    branch TEXT,
    worktree_path TEXT,
    claude_session_id TEXT,
    error TEXT,
    drop_reason TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  return c
}

const createStateSchema = async (path: string): Promise<Client> => {
  const c = createClient({ url: `file:${path}` })
  await c.execute(`CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    story TEXT NOT NULL DEFAULT '',
    technical TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    source TEXT NOT NULL DEFAULT 'human',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  await c.execute(`CREATE TABLE proposal_user_stories (
    proposal_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY(proposal_id, position)
  )`)
  return c
}

const insertTask = async (
  c: Client,
  id: string,
  status: string,
): Promise<void> => {
  const now = new Date().toISOString()
  await c.execute({
    sql: `INSERT INTO tasks (id, prompt, status, retry_count, created_at, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)`,
    args: [id, `prompt for ${id}`, status, now, now],
  })
}

const insertIdea = async (
  c: Client,
  id: string,
  status: string,
): Promise<void> => {
  const now = Date.now()
  await c.execute({
    sql: `INSERT INTO proposals (id, goal, status, source, created_at, updated_at)
          VALUES (?, ?, ?, 'human', ?, ?)`,
    args: [id, `goal for ${id}`, status, now, now],
  })
}

describe('GET /api/inbox/items', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    const queueDbPath = resolve(repo, '.mars/queue.db')
    const stateDbPath = resolve(repo, '.mars/state.db')
    const qc = await createQueueSchema(queueDbPath)
    const sc = await createStateSchema(stateDbPath)
    qc.close()
    sc.close()

    server = await startServer({
      repo,
      port: 0,
      host: '127.0.0.1',
    })
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 200 with an empty array when no items exist', async () => {
    const res = await fetch(`${baseUrl}/api/inbox/items`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InboxItemBody[]
    expect(Array.isArray(body)).toBe(true)
    expect(body).toEqual([])
  })

  it('returns items from all three sources in one array', async () => {
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    await insertTask(qc, 'task-blocked-1', 'blocked')
    await insertTask(qc, 'task-dropped-1', 'dropped')
    qc.close()
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await insertIdea(sc, 'idea-draft-1', 'draft')
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox/items`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InboxItemBody[]
    expect(Array.isArray(body)).toBe(true)
    const sources = body.map((i) => i.source).sort()
    expect(sources).toEqual(['blocked', 'draft', 'failed'])
    const ids = body.map((i) => i.id).sort()
    expect(ids).toEqual(['idea-draft-1', 'task-blocked-1', 'task-dropped-1'])
  })

  it("tags each item with a source field of 'draft', 'blocked', or 'failed'", async () => {
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    await insertTask(qc, 'tb', 'blocked')
    await insertTask(qc, 'td', 'dropped')
    qc.close()
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await insertIdea(sc, 'id', 'draft')
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox/items`)
    const body = (await res.json()) as InboxItemBody[]
    const bySource = new Map(body.map((i) => [i.id, i.source]))
    expect(bySource.get('id')).toBe('draft')
    expect(bySource.get('tb')).toBe('blocked')
    expect(bySource.get('td')).toBe('failed')
  })

  it('?source=draft returns only draft items', async () => {
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    await insertTask(qc, 'task-blocked', 'blocked')
    await insertTask(qc, 'task-dropped', 'dropped')
    qc.close()
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await insertIdea(sc, 'idea-draft', 'draft')
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox/items?source=draft`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InboxItemBody[]
    expect(body.map((i) => i.id)).toEqual(['idea-draft'])
    expect(body.every((i) => i.source === 'draft')).toBe(true)
  })

  it('?source=blocked returns only blocked items', async () => {
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    await insertTask(qc, 'task-blocked', 'blocked')
    await insertTask(qc, 'task-dropped', 'dropped')
    qc.close()
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await insertIdea(sc, 'idea-draft', 'draft')
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox/items?source=blocked`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InboxItemBody[]
    expect(body.map((i) => i.id)).toEqual(['task-blocked'])
    expect(body.every((i) => i.source === 'blocked')).toBe(true)
  })

  it('?source=failed returns only failed (dropped) items', async () => {
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    await insertTask(qc, 'task-blocked', 'blocked')
    await insertTask(qc, 'task-dropped', 'dropped')
    qc.close()
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await insertIdea(sc, 'idea-draft', 'draft')
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox/items?source=failed`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InboxItemBody[]
    expect(body.map((i) => i.id)).toEqual(['task-dropped'])
    expect(body.every((i) => i.source === 'failed')).toBe(true)
  })

  it('draft items correspond to idea rows whose status is draft', async () => {
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await insertIdea(sc, 'idea-draft-a', 'draft')
    await insertIdea(sc, 'idea-draft-b', 'draft')
    await insertIdea(sc, 'idea-shipped', 'shipped')
    await insertIdea(sc, 'idea-archived', 'archived')
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox/items?source=draft`)
    const body = (await res.json()) as InboxItemBody[]
    const ids = body.map((i) => i.id).sort()
    expect(ids).toEqual(['idea-draft-a', 'idea-draft-b'])
  })

  it('blocked items correspond to task rows whose status is blocked', async () => {
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    await insertTask(qc, 'task-blocked-a', 'blocked')
    await insertTask(qc, 'task-blocked-b', 'blocked')
    await insertTask(qc, 'task-queued', 'queued')
    await insertTask(qc, 'task-running', 'running')
    await insertTask(qc, 'task-done', 'done')
    qc.close()

    const res = await fetch(`${baseUrl}/api/inbox/items?source=blocked`)
    const body = (await res.json()) as InboxItemBody[]
    const ids = body.map((i) => i.id).sort()
    expect(ids).toEqual(['task-blocked-a', 'task-blocked-b'])
    expect(body.every((i) => i.status === 'blocked')).toBe(true)
  })

  it('failed items correspond to task rows whose status is dropped', async () => {
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    await insertTask(qc, 'task-dropped-a', 'dropped')
    await insertTask(qc, 'task-dropped-b', 'dropped')
    // 'failed' is the mid-flight, recoverable failure status — NOT what this
    // endpoint surfaces. Only 'dropped' (post-retry-budget terminal) qualifies.
    await insertTask(qc, 'task-failed-midflight', 'failed')
    qc.close()

    const res = await fetch(`${baseUrl}/api/inbox/items?source=failed`)
    const body = (await res.json()) as InboxItemBody[]
    const ids = body.map((i) => i.id).sort()
    expect(ids).toEqual(['task-dropped-a', 'task-dropped-b'])
    expect(body.every((i) => i.status === 'dropped')).toBe(true)
  })

  it('does not surface any task_suggestions rows', async () => {
    // Create a task_suggestions table populated with rows that, if leaked,
    // would show up as inbox items. The endpoint must ignore it entirely.
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    await qc.execute(`CREATE TABLE task_suggestions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
    const now = new Date().toISOString()
    await qc.execute({
      sql: `INSERT INTO task_suggestions (id, status, created_at) VALUES (?, 'draft', ?)`,
      args: ['suggestion-1', now],
    })
    await qc.execute({
      sql: `INSERT INTO task_suggestions (id, status, created_at) VALUES (?, 'blocked', ?)`,
      args: ['suggestion-2', now],
    })
    // Genuine inbox item alongside, to prove the endpoint is otherwise working.
    await insertTask(qc, 'task-blocked-real', 'blocked')
    qc.close()

    const res = await fetch(`${baseUrl}/api/inbox/items`)
    const body = (await res.json()) as InboxItemBody[]
    const ids = body.map((i) => i.id)
    expect(ids).not.toContain('suggestion-1')
    expect(ids).not.toContain('suggestion-2')
    expect(ids).toContain('task-blocked-real')
  })
})
