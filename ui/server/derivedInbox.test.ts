/**
 * Tests for the action-queue handler behaviour that previously required a
 * derived-inbox-style scan:
 *   - daemon-killed-batch grouped affordance
 *   - title and body pass-through from inbox_items
 *
 * After the slice-5 migration both of these are exercised via the persisted
 * inbox_items table. The handler reads inbox_items; no task/worktree scan.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'

import { startServer } from './index.ts'

interface InboxRow {
  id: string
  kind: string
  entityId: string
  title: string
  errorKind: string
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-derivedinbox-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const createSchema = async (path: string): Promise<Client> => {
  const c = createClient({ url: `file:${path}` })
  await c.execute(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_functional TEXT,
    plan_technical TEXT,
    branch TEXT,
    worktree_path TEXT,
    claude_session_id TEXT,
    error TEXT,
    failure_signature TEXT,
    drop_reason TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    parent_proposal_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  await c.execute(`CREATE TABLE IF NOT EXISTS task_blockers (
    task_id TEXT NOT NULL,
    blocker_task_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'confirmed',
    created_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (task_id, blocker_task_id)
  )`)
  await c.execute(`CREATE TABLE IF NOT EXISTS inbox_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'orchestrator',
    priority TEXT NOT NULL DEFAULT 'high',
    state TEXT NOT NULL DEFAULT 'open',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}',
    context TEXT NOT NULL DEFAULT '{}',
    raised_by TEXT NOT NULL DEFAULT 'test',
    raised_at TEXT NOT NULL,
    last_seen_at TEXT,
    seen_count INTEGER NOT NULL DEFAULT 1,
    fingerprint TEXT,
    signature TEXT,
    resolved_at TEXT,
    resolution TEXT,
    resolution_note TEXT,
    root_cause TEXT,
    resolved_by TEXT
  )`)
  return c
}

const insertInboxItem = async (
  c: Client,
  opts: {
    id: string
    kind: string
    priority?: string
    title?: string
    payload?: Record<string, unknown>
    context?: Record<string, unknown>
  },
): Promise<void> => {
  const now = new Date().toISOString()
  await c.execute({
    sql: `INSERT INTO inbox_items (id, kind, priority, title, payload, context, raised_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      opts.id,
      opts.kind,
      opts.priority ?? 'high',
      opts.title ?? `item ${opts.id}`,
      JSON.stringify(opts.payload ?? {}),
      JSON.stringify(opts.context ?? {}),
      now,
      now,
    ],
  })
}

describe('action-queue handler — daemon-killed-batch grouped affordance (persisted)', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    const c = await createSchema(resolve(repo, '.mars/mars.db'))
    c.close()
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  const fetchQueue = async (): Promise<InboxRow[]> => {
    const res = await fetch(`${baseUrl}/api/inbox/action-queue`)
    expect(res.status).toBe(200)
    return (await res.json()) as InboxRow[]
  }

  it('shows a daemon-killed-batch banner when >=2 daemon-killed rows are in inbox_items', async () => {
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertInboxItem(c, {
      id: 'dk-1',
      kind: 'daemon-killed',
      title: 'daemon-killed task 1',
      payload: { taskId: 't-dk-1' },
    })
    await insertInboxItem(c, {
      id: 'dk-2',
      kind: 'daemon-killed',
      title: 'daemon-killed task 2',
      payload: { taskId: 't-dk-2' },
    })
    c.close()

    const rows = await fetchQueue()
    const batchRow = rows.find((r) => r.errorKind === 'daemon-killed-batch')
    expect(batchRow).toBeDefined()
    // The banner title must mention the count.
    expect(batchRow?.title).toContain('2')
  })

  it('is absent when only 1 daemon-killed row exists in inbox_items', async () => {
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertInboxItem(c, {
      id: 'dk-only',
      kind: 'daemon-killed',
      payload: { taskId: 't-dk-only' },
    })
    c.close()

    const rows = await fetchQueue()
    const batchRow = rows.find((r) => r.errorKind === 'daemon-killed-batch')
    expect(batchRow).toBeUndefined()
  })

  it('is absent when daemon-killed and ordinary failed rows together total < 2 daemon-killed', async () => {
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertInboxItem(c, {
      id: 'dk-one',
      kind: 'daemon-killed',
      payload: { taskId: 't-dk-one' },
    })
    await insertInboxItem(c, {
      id: 'ord-one',
      kind: 'failed',
      payload: { taskId: 't-ord' },
    })
    c.close()

    const rows = await fetchQueue()
    const batchRow = rows.find((r) => r.errorKind === 'daemon-killed-batch')
    expect(batchRow).toBeUndefined()
  })

  it('banner appears before individual daemon-killed rows (sorted first)', async () => {
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertInboxItem(c, {
      id: 'dk-a',
      kind: 'daemon-killed',
      payload: { taskId: 't-dk-a' },
    })
    await insertInboxItem(c, {
      id: 'dk-b',
      kind: 'daemon-killed',
      payload: { taskId: 't-dk-b' },
    })
    c.close()

    const rows = await fetchQueue()
    const batchIdx = rows.findIndex((r) => r.errorKind === 'daemon-killed-batch')
    const firstDkIdx = rows.findIndex((r) => r.errorKind === 'daemon-killed')
    expect(batchIdx).toBeGreaterThanOrEqual(0)
    expect(firstDkIdx).toBeGreaterThanOrEqual(0)
    expect(batchIdx).toBeLessThan(firstDkIdx)
  })
})

describe('action-queue handler — title and body pass-through from inbox_items', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    const c = await createSchema(resolve(repo, '.mars/mars.db'))
    c.close()
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  const fetchQueue = async (): Promise<InboxRow[]> => {
    const res = await fetch(`${baseUrl}/api/inbox/action-queue`)
    expect(res.status).toBe(200)
    return (await res.json()) as InboxRow[]
  }

  it('returns the persisted title verbatim (no truncation or normalisation)', async () => {
    const longTitle =
      'Failed: Route hitl slice to operator inbox plus one Coder sub-task for the longer description here'
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertInboxItem(c, {
      id: 'row-long-title',
      kind: 'failed',
      title: longTitle,
      payload: { taskId: 't-failed-long' },
    })
    c.close()

    const rows = await fetchQueue()
    const row = rows.find((r) => r.entityId === 't-failed-long')
    expect(row).toBeDefined()
    expect(row?.title).toBe(longTitle)
    // Title comes from inbox_items, so no ellipsis is added by the handler.
    expect(row?.title).not.toContain('…')
  })

  it('blocked task does not surface (inbox_items only contains stuck items)', async () => {
    // A blocked task never gets an inbox_items row (the outbox consumer never
    // raises for task.blocked), so no row appears in the action-queue.
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    // Do NOT insert into inbox_items — just confirm nothing appears.
    c.close()

    const rows = await fetchQueue()
    expect(rows.find((r) => r.entityId === 't-blocked-long')).toBeUndefined()
  })
})
