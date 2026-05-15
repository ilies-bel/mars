import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'

import { startServer } from './index.ts'

interface InboxBody {
  drafts: Array<{ id: string; status: string }>
  blocked: Array<{ id: string; status: string }>
  failed: Array<{ id: string; status: string }>
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-inbox-test-'))
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
  await c.execute(`CREATE TABLE ideas (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    story TEXT NOT NULL DEFAULT '',
    technical TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    source TEXT NOT NULL DEFAULT 'human',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  await c.execute(`CREATE TABLE idea_user_stories (
    id TEXT PRIMARY KEY,
    idea_id TEXT NOT NULL,
    story TEXT NOT NULL
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
    sql: `INSERT INTO ideas (id, goal, status, source, created_at, updated_at)
          VALUES (?, ?, ?, 'human', ?, ?)`,
    args: [id, `goal for ${id}`, status, now, now],
  })
}

describe('GET /api/inbox', () => {
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

  it('returns 200 with { drafts, blocked, failed } shape when state is empty', async () => {
    const res = await fetch(`${baseUrl}/api/inbox`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InboxBody
    expect(Array.isArray(body.drafts)).toBe(true)
    expect(Array.isArray(body.blocked)).toBe(true)
    expect(Array.isArray(body.failed)).toBe(true)
    expect(body.drafts).toEqual([])
    expect(body.blocked).toEqual([])
    expect(body.failed).toEqual([])
  })

  it('drafts contains only ideas whose status is draft', async () => {
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await insertIdea(sc, 'idea-draft-1', 'draft')
    await insertIdea(sc, 'idea-draft-2', 'draft')
    await insertIdea(sc, 'idea-shipped', 'shipped')
    await insertIdea(sc, 'idea-archived', 'archived')
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InboxBody
    const ids = body.drafts.map((d) => d.id).sort()
    expect(ids).toEqual(['idea-draft-1', 'idea-draft-2'])
    for (const d of body.drafts) {
      expect(d.status).toBe('draft')
    }
  })

  it('blocked contains only tasks whose status is blocked', async () => {
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    await insertTask(qc, 'task-blocked-1', 'blocked')
    await insertTask(qc, 'task-blocked-2', 'blocked')
    await insertTask(qc, 'task-queued', 'queued')
    await insertTask(qc, 'task-done', 'done')
    qc.close()

    const res = await fetch(`${baseUrl}/api/inbox`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InboxBody
    const ids = body.blocked.map((t) => t.id).sort()
    expect(ids).toEqual(['task-blocked-1', 'task-blocked-2'])
    for (const t of body.blocked) {
      expect(t.status).toBe('blocked')
    }
  })

  it('failed contains only tasks whose status is failed', async () => {
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    await insertTask(qc, 'task-failed-1', 'failed')
    await insertTask(qc, 'task-running', 'running')
    await insertTask(qc, 'task-blocked', 'blocked')
    qc.close()

    const res = await fetch(`${baseUrl}/api/inbox`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InboxBody
    const ids = body.failed.map((t) => t.id).sort()
    expect(ids).toEqual(['task-failed-1'])
    for (const t of body.failed) {
      expect(t.status).toBe('failed')
    }
    // And blocked still contains exactly the blocked one — failed never
    // leaks into blocked.
    expect(body.blocked.map((t) => t.id)).toEqual(['task-blocked'])
  })

  it('empty groups are returned as empty arrays even when others are populated', async () => {
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    await insertTask(qc, 'task-blocked-only', 'blocked')
    qc.close()

    const res = await fetch(`${baseUrl}/api/inbox`)
    const body = (await res.json()) as InboxBody
    expect(body.drafts).toEqual([])
    expect(body.failed).toEqual([])
    expect(body.blocked.length).toBe(1)
  })
})
