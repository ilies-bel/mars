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
  entityId: string
  priority: string
  title: string
  body: string
  at: string
  dag: {
    blockers: Array<{ id: string; status: string; summary: string }>
    blocking: Array<{ id: string; status: string; summary: string }>
    descendants: Array<{ id: string; status: string; summary: string }>
    proposalId: string | null
  } | null
  dismissed: boolean
  ackState: 'ack' | 'resolved' | 'dismissed' | null
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-action-queue-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

// Tasks, proposals and dismissals now share one .mars/mars.db file
// (see resolveRepo). The derived view reads worktrees from disk.
const queueDbPath = (repo: string): string => resolve(repo, '.mars/mars.db')
const stateDbPath = (repo: string): string => resolve(repo, '.mars/mars.db')

const createQueueSchema = async (path: string): Promise<Client> => {
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
  return c
}

const insertTask = async (
  c: Client,
  opts: {
    id: string
    status: string
    prompt?: string
    error?: string
    parentProposalId?: string
    updatedAt?: string
  },
): Promise<void> => {
  const now = opts.updatedAt ?? new Date().toISOString()
  await c.execute({
    sql: `INSERT INTO tasks (id, prompt, status, error, parent_proposal_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      opts.id,
      opts.prompt ?? `prompt for ${opts.id}`,
      opts.status,
      opts.error ?? null,
      opts.parentProposalId ?? null,
      now,
      now,
    ],
  })
}

describe('GET /api/inbox/action-queue (derived view)', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    const c = await createQueueSchema(queueDbPath(repo))
    c.close()
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  const fetchQueue = async (
    filter?: string,
  ): Promise<ActionQueueItemBody[]> => {
    const q = filter ? `?filter=${filter}` : ''
    const res = await fetch(`${baseUrl}/api/inbox/action-queue${q}`)
    expect(res.status).toBe(200)
    return (await res.json()) as ActionQueueItemBody[]
  }

  it('returns an empty array when nothing needs attention', async () => {
    const body = await fetchQueue()
    expect(body).toEqual([])
  })

  it('surfaces failed and dropped tasks as one high-priority row each', async () => {
    const c = createClient({ url: `file:${queueDbPath(repo)}` })
    await insertTask(c, { id: 't-failed', status: 'failed', error: 'boom' })
    await insertTask(c, { id: 't-dropped', status: 'dropped' })
    await insertTask(c, { id: 't-done', status: 'done' })
    c.close()

    const body = await fetchQueue()
    const byEntity = new Map(body.map((r) => [r.entityId, r]))
    expect(byEntity.has('t-failed')).toBe(true)
    expect(byEntity.has('t-dropped')).toBe(true)
    expect(byEntity.has('t-done')).toBe(false)
    expect(byEntity.get('t-failed')?.kind).toBe('failed-task')
    expect(byEntity.get('t-failed')?.priority).toBe('high')
    expect(byEntity.get('t-failed')?.id).toBe('failed-task:t-failed')
  })

  it('surfaces blocked tasks with their blocker DAG', async () => {
    const c = createClient({ url: `file:${queueDbPath(repo)}` })
    await insertTask(c, { id: 't-blocked', status: 'blocked' })
    await insertTask(c, { id: 't-blocker', status: 'running' })
    await c.execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
            VALUES ('t-blocked', 't-blocker', 'confirmed', '2025-01-01')`,
      args: [],
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.entityId === 't-blocked')
    expect(row).toBeDefined()
    expect(row?.kind).toBe('blocked-task')
    expect(row?.dag?.blockers.map((b) => b.id)).toEqual(['t-blocker'])
  })

  it('surfaces a draft proposal as a row', async () => {
    const c = createClient({ url: `file:${stateDbPath(repo)}` })
    await c.execute(`CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      problem TEXT NOT NULL DEFAULT '',
      solution TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'human',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    await c.execute(`CREATE TABLE IF NOT EXISTS proposal_user_stories (
      proposal_id TEXT NOT NULL,
      story TEXT NOT NULL DEFAULT ''
    )`)
    const now = Date.now()
    await c.execute({
      sql: `INSERT INTO proposals (id, title, status, created_at, updated_at)
            VALUES ('p-1', 'some draft title', 'draft', ?, ?)`,
      args: [now, now],
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.entityId === 'p-1')
    expect(row).toBeDefined()
    expect(row?.kind).toBe('draft-proposal')
  })

  it('surfaces a worktree on disk whose task is terminal as a stale-worktree row', async () => {
    const c = createClient({ url: `file:${queueDbPath(repo)}` })
    await insertTask(c, { id: 'wt-done', status: 'done' })
    c.close()
    mkdirSync(resolve(repo, '.mars/worktrees/wt-done'), { recursive: true })

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'stale-worktree:wt-done')
    expect(row).toBeDefined()
    expect(row?.kind).toBe('stale-worktree')
    expect(row?.priority).toBe('low')
  })

  it('does NOT flag a worktree whose task is still live', async () => {
    const c = createClient({ url: `file:${queueDbPath(repo)}` })
    await insertTask(c, { id: 'wt-live', status: 'running' })
    c.close()
    mkdirSync(resolve(repo, '.mars/worktrees/wt-live'), { recursive: true })

    const body = await fetchQueue()
    expect(body.find((r) => r.id === 'stale-worktree:wt-live')).toBeUndefined()
  })

  it('hides dismissed rows under the default filter and shows them under all', async () => {
    const c = createClient({ url: `file:${queueDbPath(repo)}` })
    await insertTask(c, { id: 't-failed', status: 'failed' })
    c.close()

    const dismissRes = await fetch(`${baseUrl}/api/inbox/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'failed-task:t-failed' }),
    })
    expect(dismissRes.status).toBe(200)

    const open = await fetchQueue()
    expect(open.find((r) => r.entityId === 't-failed')).toBeUndefined()

    const all = await fetchQueue('all')
    const row = all.find((r) => r.entityId === 't-failed')
    expect(row?.dismissed).toBe(true)
    expect(row?.ackState).toBe('dismissed')
  })

  it('ack keeps row visible in open filter and sets ackState; resolve hides it — UI→seam→UI round trip', async () => {
    const c = createClient({ url: `file:${queueDbPath(repo)}` })
    await insertTask(c, { id: 't-round', status: 'failed', error: 'oops' })
    c.close()

    // Baseline: item appears in open filter with no ackState
    const before = await fetchQueue()
    const row0 = before.find((r) => r.entityId === 't-round')
    expect(row0).toBeDefined()
    expect(row0?.ackState).toBeNull()
    expect(row0?.dismissed).toBe(false)

    // Ack from the web UI
    const ackRes = await fetch(`${baseUrl}/api/inbox/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'failed-task:t-round' }),
    })
    expect(ackRes.status).toBe(200)

    // After ack: item STILL shows in open filter (not hidden), but carries ackState
    const afterAck = await fetchQueue()
    const rowAck = afterAck.find((r) => r.entityId === 't-round')
    expect(rowAck).toBeDefined()
    expect(rowAck?.ackState).toBe('ack')
    expect(rowAck?.dismissed).toBe(false)

    // Resolve from the web UI (the "CLI sees it" surface is the same shared DB)
    const resolveRes = await fetch(`${baseUrl}/api/inbox/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'failed-task:t-round' }),
    })
    expect(resolveRes.status).toBe(200)

    // After resolve: item is HIDDEN from open filter
    const afterResolve = await fetchQueue()
    expect(afterResolve.find((r) => r.entityId === 't-round')).toBeUndefined()

    // But visible under ?filter=all with resolved ackState (what 'mars inbox list all' would show)
    const allRows = await fetchQueue('all')
    const rowResolved = allRows.find((r) => r.entityId === 't-round')
    expect(rowResolved?.ackState).toBe('resolved')
    expect(rowResolved?.dismissed).toBe(true)
  })

  it('returns 200 with empty array on a fresh repo (no tasks table)', async () => {
    const c = createClient({ url: `file:${queueDbPath(repo)}` })
    await c.execute(`DROP TABLE IF EXISTS tasks`)
    c.close()
    const body = await fetchQueue()
    expect(body).toEqual([])
  })
})
