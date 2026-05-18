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

  it('returns a single object with exactly the keys drafts, blocked, failed', async () => {
    // Populate every bucket plus a dropped task so the keys assertion is
    // exercised against a non-trivial payload.
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    await insertTask(qc, 'task-b', 'blocked')
    await insertTask(qc, 'task-f', 'failed')
    await insertTask(qc, 'task-d', 'dropped')
    qc.close()
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await insertIdea(sc, 'idea-d', 'draft')
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['blocked', 'drafts', 'failed'])
  })

  it('does not place dropped tasks in any bucket', async () => {
    const qc = createClient({ url: `file:${resolve(repo, '.mars/queue.db')}` })
    // A dropped task alongside populated blocked + failed buckets — dropped
    // is superseded/cancelled work, never operator-review, so it must not
    // surface here.
    await insertTask(qc, 'task-blocked-live', 'blocked')
    await insertTask(qc, 'task-failed-live', 'failed')
    await insertTask(qc, 'task-dropped-superseded', 'dropped')
    await insertTask(qc, 'task-dropped-cancelled', 'dropped')
    qc.close()

    const res = await fetch(`${baseUrl}/api/inbox`)
    const body = (await res.json()) as InboxBody
    const allIds = [
      ...body.drafts.map((d) => d.id),
      ...body.blocked.map((t) => t.id),
      ...body.failed.map((t) => t.id),
    ]
    expect(allIds).not.toContain('task-dropped-superseded')
    expect(allIds).not.toContain('task-dropped-cancelled')
    // Sanity: the live buckets still surface their entries.
    expect(body.blocked.map((t) => t.id)).toEqual(['task-blocked-live'])
    expect(body.failed.map((t) => t.id)).toEqual(['task-failed-live'])
  })

  it('ignores a source query argument and returns the same grouped object', async () => {
    // Populate ideas with mixed sources to make a hypothetical server-side
    // filter visibly wrong if it ever leaked in.
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await sc.execute({
      sql: `INSERT INTO proposals (id, goal, status, source, created_at, updated_at)
            VALUES (?, ?, 'draft', 'human', ?, ?)`,
      args: ['idea-human', 'human goal', Date.now(), Date.now()],
    })
    await sc.execute({
      sql: `INSERT INTO proposals (id, goal, status, source, created_at, updated_at)
            VALUES (?, ?, 'draft', 'reflection', ?, ?)`,
      args: ['idea-reflection', 'reflection goal', Date.now(), Date.now()],
    })
    sc.close()

    const plain = await fetch(`${baseUrl}/api/inbox`)
    const filtered = await fetch(`${baseUrl}/api/inbox?source=human`)
    expect(plain.status).toBe(200)
    expect(filtered.status).toBe(200)
    const plainBody = (await plain.json()) as InboxBody
    const filteredBody = (await filtered.json()) as InboxBody
    // Identical payload — filtering is the client's job.
    expect(filteredBody).toEqual(plainBody)
    // And both contain BOTH sources, proving no server-side source filter.
    const ids = plainBody.drafts.map((d) => d.id).sort()
    expect(ids).toEqual(['idea-human', 'idea-reflection'])
  })
})
