import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'

import { startServer } from './index.ts'

interface ActionQueueItemBody {
  id: string
  kind: string
  title: string
  body: string
  raisedAt: string
  lastSeenAt: string
  seenCount: number
  priority: string
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-action-queue-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const createStateSchemaWithInbox = async (path: string): Promise<Client> => {
  const c = createClient({ url: `file:${path}` })
  await c.execute(`CREATE TABLE IF NOT EXISTS inbox_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal',
    state TEXT NOT NULL DEFAULT 'open',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}',
    context TEXT NOT NULL DEFAULT '{}',
    raised_by TEXT NOT NULL DEFAULT 'test',
    raised_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT,
    resolution_note TEXT,
    root_cause TEXT,
    fingerprint TEXT,
    signature TEXT,
    seen_count INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT,
    resolved_by TEXT
  )`)
  return c
}

const insertInboxItem = async (
  c: Client,
  opts: {
    id: string
    kind?: string
    title: string
    body?: string
    state?: string
    priority?: string
    raisedAt?: string
    lastSeenAt?: string
    seenCount?: number
  },
): Promise<void> => {
  const now = opts.raisedAt ?? new Date().toISOString()
  await c.execute({
    sql: `INSERT INTO inbox_items
            (id, kind, title, body, state, priority, raised_at, last_seen_at, seen_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      opts.id,
      opts.kind ?? 'failed',
      opts.title,
      opts.body ?? '',
      opts.state ?? 'open',
      opts.priority ?? 'normal',
      now,
      opts.lastSeenAt ?? now,
      opts.seenCount ?? 1,
    ],
  })
}

describe('GET /api/inbox/action-queue', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    const stateDbPath = resolve(repo, '.mars/state.db')
    const sc = await createStateSchemaWithInbox(stateDbPath)
    sc.close()

    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 200 with an empty array when inbox_items is empty', async () => {
    const res = await fetch(`${baseUrl}/api/inbox/action-queue`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ActionQueueItemBody[]
    expect(Array.isArray(body)).toBe(true)
    expect(body).toEqual([])
  })

  it('returns open inbox items with title, body, raisedAt, lastSeenAt', async () => {
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await insertInboxItem(sc, {
      id: 'item-1',
      kind: 'failed',
      title: 'Fix the login service',
      body: 'Restart the daemon and re-run the task',
      priority: 'high',
    })
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox/action-queue`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ActionQueueItemBody[]
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe('item-1')
    expect(body[0].title).toBe('Fix the login service')
    expect(body[0].body).toBe('Restart the daemon and re-run the task')
    expect(body[0].kind).toBe('failed')
    expect(body[0].priority).toBe('high')
    expect(typeof body[0].raisedAt).toBe('string')
    expect(typeof body[0].lastSeenAt).toBe('string')
    expect(typeof body[0].seenCount).toBe('number')
  })

  it('returns only open items — resolved and dismissed are excluded', async () => {
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await insertInboxItem(sc, { id: 'open-1', title: 'Open task', state: 'open' })
    await insertInboxItem(sc, { id: 'resolved-1', title: 'Resolved task', state: 'resolved' })
    await insertInboxItem(sc, { id: 'dismissed-1', title: 'Dismissed task', state: 'dismissed' })
    await insertInboxItem(sc, { id: 'acknowledged-1', title: 'Acked task', state: 'acknowledged' })
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox/action-queue`)
    const body = (await res.json()) as ActionQueueItemBody[]
    const ids = body.map((i) => i.id).sort()
    // open and acknowledged are surfaced; resolved/dismissed are not
    expect(ids).toEqual(['acknowledged-1', 'open-1'])
  })

  it('returns items ordered by raised_at DESC (newest first)', async () => {
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await insertInboxItem(sc, {
      id: 'older',
      title: 'Older item',
      raisedAt: '2025-01-01T00:00:00.000Z',
    })
    await insertInboxItem(sc, {
      id: 'newer',
      title: 'Newer item',
      raisedAt: '2025-06-01T00:00:00.000Z',
    })
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox/action-queue`)
    const body = (await res.json()) as ActionQueueItemBody[]
    expect(body[0].id).toBe('newer')
    expect(body[1].id).toBe('older')
  })

  it('returns 200 with empty array when inbox_items table does not exist', async () => {
    // Drop the inbox_items table so the server must tolerate a fresh repo
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await sc.execute(`DROP TABLE IF EXISTS inbox_items`)
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox/action-queue`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ActionQueueItemBody[]
    expect(Array.isArray(body)).toBe(true)
    expect(body).toEqual([])
  })

  it('does not surface drafts or stale-worktree synthesised rows', async () => {
    // Seed a proposals table (drafts) — must NOT appear in action-queue
    const sc = createClient({ url: `file:${resolve(repo, '.mars/state.db')}` })
    await sc.execute(`CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      story TEXT NOT NULL DEFAULT '',
      technical TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'human',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    const now = Date.now()
    await sc.execute({
      sql: `INSERT INTO proposals (id, goal, status, created_at, updated_at)
            VALUES ('draft-1', 'some draft goal', 'draft', ?, ?)`,
      args: [now, now],
    })
    // Also insert a real inbox item
    await insertInboxItem(sc, { id: 'inbox-1', title: 'Real inbox item' })
    sc.close()

    const res = await fetch(`${baseUrl}/api/inbox/action-queue`)
    const body = (await res.json()) as ActionQueueItemBody[]
    const ids = body.map((i) => i.id)
    expect(ids).not.toContain('draft-1')
    expect(ids).toContain('inbox-1')
  })
})
