import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'

import { startServer } from './index.ts'
import { makeDaemonStub } from './testDaemonStub.ts'

interface EventEntry {
  taskId: string
  kind: 'completed' | 'failed' | 'dropped'
  occurredAt: string
  recoverySpawnedCount: number
  summary: string
}

interface EventsBody {
  events: EventEntry[]
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-events-test-'))
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
    recovery_spawned_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  return c
}

const createStateSchema = async (path: string): Promise<Client> => {
  const c = createClient({ url: `file:${path}` })
  await c.execute(`CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    problem TEXT NOT NULL DEFAULT '',
    solution TEXT NOT NULL DEFAULT '',
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

interface InsertTaskArgs {
  id: string
  status: string
  recoverySpawnedCount?: number
  prompt?: string
  createdAt?: string
  updatedAt?: string
}

const insertTask = async (c: Client, args: InsertTaskArgs): Promise<void> => {
  const now = new Date().toISOString()
  await c.execute({
    sql: `INSERT INTO tasks (id, prompt, status, recovery_spawned_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      args.id,
      args.prompt ?? `prompt for ${args.id}`,
      args.status,
      args.recoverySpawnedCount ?? 0,
      args.createdAt ?? now,
      args.updatedAt ?? now,
    ],
  })
}

describe('GET /api/events', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string
  let queueDbPath: string

  beforeEach(async () => {
    repo = setupRepo()
    queueDbPath = resolve(repo, '.mars/mars.db')
    const stateDbPath = resolve(repo, '.mars/mars.db')
    const qc = await createQueueSchema(queueDbPath)
    const sc = await createStateSchema(stateDbPath)
    qc.close()
    sc.close()

    server = await startServer(
      {
        repo,
        port: 0,
        host: '127.0.0.1',
      },
      { proxyGet: makeDaemonStub(repo) },
    )
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns an empty events array when no tasks exist', async () => {
    const res = await fetch(`${baseUrl}/api/events`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as EventsBody
    expect(Array.isArray(body.events)).toBe(true)
    expect(body.events).toEqual([])
  })

  it("emits exactly one 'completed' event for a task that finished as done", async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, {
      id: 'task-done-1',
      status: 'done',
      prompt: 'ship the thing',
      recoverySpawnedCount: 0,
      updatedAt: '2026-05-15T10:00:00.000Z',
    })
    qc.close()

    const res = await fetch(`${baseUrl}/api/events`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as EventsBody
    expect(body.events).toHaveLength(1)
    const ev = body.events[0]!
    expect(ev.taskId).toBe('task-done-1')
    expect(ev.kind).toBe('completed')
    expect(ev.occurredAt).toBe('2026-05-15T10:00:00.000Z')
    expect(ev.recoverySpawnedCount).toBe(0)
    expect(typeof ev.summary).toBe('string')
    expect(ev.summary.length).toBeGreaterThan(0)
  })

  it('only emits the three terminal kinds (completed | failed | dropped)', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, { id: 't-queued', status: 'queued' })
    await insertTask(qc, { id: 't-running', status: 'running' })
    await insertTask(qc, { id: 't-blocked', status: 'blocked' })
    await insertTask(qc, { id: 't-verifying', status: 'verifying' })
    await insertTask(qc, { id: 't-done', status: 'done' })
    await insertTask(qc, { id: 't-failed', status: 'failed' })
    await insertTask(qc, { id: 't-dropped', status: 'dropped' })
    qc.close()

    const res = await fetch(`${baseUrl}/api/events`)
    const body = (await res.json()) as EventsBody
    const kinds = new Set(body.events.map((e) => e.kind))
    for (const k of kinds) {
      expect(['completed', 'failed', 'dropped']).toContain(k)
    }
    // Non-terminal statuses contribute zero events.
    const sourceIds = body.events.map((e) => e.taskId)
    expect(sourceIds).not.toContain('t-queued')
    expect(sourceIds).not.toContain('t-running')
    expect(sourceIds).not.toContain('t-blocked')
    expect(sourceIds).not.toContain('t-verifying')
  })

  it("emits two 'failed' entries plus one 'dropped' entry for a task that failed twice and was dropped", async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, {
      id: 'task-drop',
      status: 'dropped',
      recoverySpawnedCount: 2,
      updatedAt: '2026-05-15T12:00:00.000Z',
    })
    qc.close()

    const res = await fetch(`${baseUrl}/api/events`)
    const body = (await res.json()) as EventsBody
    const forTask = body.events.filter((e) => e.taskId === 'task-drop')
    const failed = forTask.filter((e) => e.kind === 'failed')
    const dropped = forTask.filter((e) => e.kind === 'dropped')
    expect(failed).toHaveLength(2)
    expect(dropped).toHaveLength(1)
    expect(forTask).toHaveLength(3)
  })

  it("emits one 'failed' entry for a task currently in status='failed' with no retries yet", async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, {
      id: 'task-fail',
      status: 'failed',
      recoverySpawnedCount: 0,
    })
    qc.close()

    const res = await fetch(`${baseUrl}/api/events`)
    const body = (await res.json()) as EventsBody
    const forTask = body.events.filter((e) => e.taskId === 'task-fail')
    expect(forTask).toHaveLength(1)
    expect(forTask[0]!.kind).toBe('failed')
  })

  it('returns events sorted newest-first by occurredAt', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, {
      id: 'older',
      status: 'done',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await insertTask(qc, {
      id: 'newest',
      status: 'done',
      updatedAt: '2026-05-15T12:00:00.000Z',
    })
    await insertTask(qc, {
      id: 'middle',
      status: 'done',
      updatedAt: '2026-03-01T00:00:00.000Z',
    })
    qc.close()

    const res = await fetch(`${baseUrl}/api/events`)
    const body = (await res.json()) as EventsBody
    const ids = body.events.map((e) => e.taskId)
    expect(ids).toEqual(['newest', 'middle', 'older'])
    // And the timestamps are themselves monotonically non-increasing.
    for (let i = 1; i < body.events.length; i++) {
      expect(body.events[i - 1]!.occurredAt >= body.events[i]!.occurredAt).toBe(
        true,
      )
    }
  })

  it('caps the response at 200 entries', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    // 250 done tasks → 250 candidate events; the endpoint must trim to 200.
    for (let i = 0; i < 250; i++) {
      // Pad so ISO order matches numerical order.
      const stamp = `2026-01-${String((i % 28) + 1).padStart(2, '0')}T${String(
        i % 24,
      ).padStart(2, '0')}:00:00.${String(i).padStart(3, '0')}Z`
      await insertTask(qc, {
        id: `t-${String(i).padStart(3, '0')}`,
        status: 'done',
        updatedAt: stamp,
      })
    }
    qc.close()

    const res = await fetch(`${baseUrl}/api/events`)
    const body = (await res.json()) as EventsBody
    expect(body.events.length).toBeLessThanOrEqual(200)
    expect(body.events.length).toBe(200)
  })

  it('survives an empty queue DB (table-missing case)', async () => {
    // Delete the queue DB so the table doesn't exist.
    const qc = createClient({ url: `file:${queueDbPath}` })
    await qc.execute(`DROP TABLE tasks`)
    qc.close()

    const res = await fetch(`${baseUrl}/api/events`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as EventsBody
    expect(body.events).toEqual([])
  })
})
