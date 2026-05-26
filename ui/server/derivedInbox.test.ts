/**
 * Tests for the failed/blocked task title in the derived inbox, and for
 * the grouped 'restart all daemon-killed' affordance.
 *
 * The title must carry the FULL collapsed first line of the task prompt
 * — no 60-char cap, no trailing '…'. Multi-line prompts collapse to a
 * single whitespace-normalised line.
 *
 * The grouped affordance appears as a synthetic 'daemon-killed-batch' row
 * when ≥2 daemon-killed tasks are present, and is absent when fewer exist.
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
  return c
}

const insertTask = async (
  c: Client,
  opts: { id: string; status: string; prompt: string; failureSignature?: string },
): Promise<void> => {
  const now = new Date().toISOString()
  await c.execute({
    sql: `INSERT INTO tasks (id, prompt, status, failure_signature, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [opts.id, opts.prompt, opts.status, opts.failureSignature ?? null, now, now],
  })
}

describe('derived inbox — daemon-killed-batch grouped affordance', () => {
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

  it('shows a daemon-killed-batch banner when >=2 daemon-killed tasks exist', async () => {
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertTask(c, {
      id: 't-dk-1',
      status: 'failed',
      prompt: 'first daemon-killed task',
      failureSignature: 'daemon-killed',
    })
    await insertTask(c, {
      id: 't-dk-2',
      status: 'failed',
      prompt: 'second daemon-killed task',
      failureSignature: 'daemon-killed',
    })
    c.close()

    const rows = await fetchQueue()
    const batchRow = rows.find((r) => r.errorKind === 'daemon-killed-batch')
    expect(batchRow).toBeDefined()
    // The banner title must mention the count.
    expect(batchRow?.title).toContain('2')
  })

  it('is absent when only 1 daemon-killed task exists', async () => {
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertTask(c, {
      id: 't-dk-only',
      status: 'failed',
      prompt: 'single daemon-killed task',
      failureSignature: 'daemon-killed',
    })
    c.close()

    const rows = await fetchQueue()
    const batchRow = rows.find((r) => r.errorKind === 'daemon-killed-batch')
    expect(batchRow).toBeUndefined()
  })

  it('is absent when daemon-killed tasks are mixed with ordinary failed tasks but count < 2', async () => {
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertTask(c, {
      id: 't-dk-one',
      status: 'failed',
      prompt: 'daemon-killed task',
      failureSignature: 'daemon-killed',
    })
    await insertTask(c, {
      id: 't-ordinary',
      status: 'failed',
      prompt: 'ordinary failed task',
    })
    c.close()

    const rows = await fetchQueue()
    const batchRow = rows.find((r) => r.errorKind === 'daemon-killed-batch')
    expect(batchRow).toBeUndefined()
  })

  it('banner appears before individual daemon-killed rows (high priority, sorted first)', async () => {
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertTask(c, {
      id: 't-dk-a',
      status: 'failed',
      prompt: 'daemon-killed A',
      failureSignature: 'daemon-killed',
    })
    await insertTask(c, {
      id: 't-dk-b',
      status: 'failed',
      prompt: 'daemon-killed B',
      failureSignature: 'daemon-killed',
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

describe('derived inbox — failed/blocked task title (no 60-char cap)', () => {
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

  it('failed task title carries the full prompt beyond 60 chars with no ellipsis', async () => {
    const longPrompt =
      'Route hitl slice to operator inbox plus one Coder sub-task for the longer description here'
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertTask(c, { id: 't-failed-long', status: 'failed', prompt: longPrompt })
    c.close()

    const rows = await fetchQueue()
    const row = rows.find((r) => r.entityId === 't-failed-long')
    expect(row).toBeDefined()
    expect(row?.title).toBe(`Failed: ${longPrompt}`)
    expect(row?.title).not.toContain('…')
  })

  it('blocked task produces no inbox row', async () => {
    const longPrompt =
      'Route hitl slice to operator inbox plus one Coder sub-task for the longer description here'
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertTask(c, { id: 't-blocked-long', status: 'blocked', prompt: longPrompt })
    c.close()

    const rows = await fetchQueue()
    // Blocked tasks auto-unblock when their blockers reach 'done' — they are
    // normal DAG state and must NOT surface as inbox rows.
    expect(rows.find((r) => r.entityId === 't-blocked-long')).toBeUndefined()
  })

  it('multi-line failed task prompt collapses to a single whitespace-normalised line', async () => {
    const multiLinePrompt = 'First line of the prompt\nSecond line\n  Third line with indent'
    const c = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertTask(c, { id: 't-failed-multi', status: 'failed', prompt: multiLinePrompt })
    c.close()

    const rows = await fetchQueue()
    const row = rows.find((r) => r.entityId === 't-failed-multi')
    expect(row).toBeDefined()
    expect(row?.title).toBe('Failed: First line of the prompt Second line Third line with indent')
    expect(row?.title).not.toContain('\n')
  })
})
