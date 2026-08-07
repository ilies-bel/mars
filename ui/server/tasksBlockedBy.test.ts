import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'

import { startServer } from './index.ts'
import { makeDaemonStub } from './testDaemonStub.ts'

/**
 * PRD 82df662a slice 1: every task returned by /api/tasks carries the
 * full list of its blocker task ids (`blockedBy: string[]`) so the
 * Topology tab can render the DAG of blocker edges without a second
 * round-trip.
 *
 * These tests pin behaviour through the public HTTP surface — they do
 * not assume any particular SQL shape, only that the endpoint reflects
 * the contents of the `task_blockers` table.
 */

interface TaskBody {
  id: string
  status: string
  blockedBy: string[]
}

interface TasksBody {
  tasks: TaskBody[]
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-tasks-blockedby-test-'))
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
  await c.execute(`CREATE TABLE task_blockers (
    task_id TEXT NOT NULL,
    blocker_task_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'confirmed',
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, blocker_task_id)
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
  return c
}

const insertTask = async (
  c: Client,
  id: string,
  status: string,
  createdAt: string = new Date().toISOString(),
): Promise<void> => {
  await c.execute({
    sql: `INSERT INTO tasks (id, prompt, status, recovery_spawned_count, created_at, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)`,
    args: [id, `prompt for ${id}`, status, createdAt, createdAt],
  })
}

const insertBlocker = async (
  c: Client,
  taskId: string,
  blockerTaskId: string,
  createdAt: string = new Date().toISOString(),
): Promise<void> => {
  await c.execute({
    sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
          VALUES (?, ?, 'confirmed', ?)`,
    args: [taskId, blockerTaskId, createdAt],
  })
}

/**
 * Edge-case: when the queue DB was created before the task_blockers table was
 * added (older schema), the server must still return `blockedBy: []` rather
 * than a missing field or null.
 */
describe('GET /api/tasks — blockedBy field (no task_blockers table)', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string
  let queueDbPath: string

  beforeEach(async () => {
    repo = setupRepo()
    queueDbPath = resolve(repo, '.mars/mars.db')
    const stateDbPath = resolve(repo, '.mars/mars.db')
    // Create schema WITHOUT task_blockers to simulate an older deployment.
    const qc = createClient({ url: `file:${queueDbPath}` })
    await qc.execute(`CREATE TABLE tasks (
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
    qc.close()
    const sc = await createStateSchema(stateDbPath)
    sc.close()

    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: makeDaemonStub(repo) },
    )
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns blockedBy: [] for all tasks when task_blockers table is absent', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await qc.execute({
      sql: `INSERT INTO tasks (id, prompt, status, recovery_spawned_count, created_at, updated_at)
            VALUES ('t-legacy', 'legacy task', 'queued', 0, ?, ?)`,
      args: [new Date().toISOString(), new Date().toISOString()],
    })
    qc.close()

    const res = await fetch(`${baseUrl}/api/tasks`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as TasksBody
    expect(body.tasks).toHaveLength(1)
    expect(Array.isArray(body.tasks[0]!.blockedBy)).toBe(true)
    expect(body.tasks[0]!.blockedBy).toEqual([])
  })
})

describe('GET /api/tasks — blockedBy field', () => {
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

  it('returns an empty list for tasks with no blockers (never a missing field)', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, 't-free-1', 'queued')
    await insertTask(qc, 't-free-2', 'running')
    qc.close()

    const res = await fetch(`${baseUrl}/api/tasks`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as TasksBody
    for (const task of body.tasks) {
      expect(Array.isArray(task.blockedBy)).toBe(true)
      expect(task.blockedBy).toEqual([])
    }
  })

  it('lists every blocker id for a task blocked by multiple tasks', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, 't-blocker-a', 'queued', '2026-05-20T10:00:00.000Z')
    await insertTask(qc, 't-blocker-b', 'queued', '2026-05-20T10:00:01.000Z')
    await insertTask(qc, 't-blocker-c', 'queued', '2026-05-20T10:00:02.000Z')
    await insertTask(qc, 't-blocked', 'blocked', '2026-05-20T10:00:03.000Z')
    await insertBlocker(qc, 't-blocked', 't-blocker-a', '2026-05-20T10:00:04.000Z')
    await insertBlocker(qc, 't-blocked', 't-blocker-b', '2026-05-20T10:00:05.000Z')
    await insertBlocker(qc, 't-blocked', 't-blocker-c', '2026-05-20T10:00:06.000Z')
    qc.close()

    const res = await fetch(`${baseUrl}/api/tasks`)
    const body = (await res.json()) as TasksBody
    const blocked = body.tasks.find((t) => t.id === 't-blocked')
    expect(blocked).toBeDefined()
    expect([...(blocked?.blockedBy ?? [])].sort()).toEqual([
      't-blocker-a',
      't-blocker-b',
      't-blocker-c',
    ])

    // Free tasks remain free.
    for (const t of body.tasks) {
      if (t.id !== 't-blocked') expect(t.blockedBy).toEqual([])
    }
  })

  it('reflects blocker removal from the queue database on the next read', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, 't-blocker', 'queued')
    await insertTask(qc, 't-target', 'blocked')
    await insertBlocker(qc, 't-target', 't-blocker')
    qc.close()

    const first = (await (await fetch(`${baseUrl}/api/tasks`)).json()) as TasksBody
    const target1 = first.tasks.find((t) => t.id === 't-target')
    expect(target1?.blockedBy).toEqual(['t-blocker'])

    const qc2 = createClient({ url: `file:${queueDbPath}` })
    await qc2.execute({
      sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
      args: ['t-target', 't-blocker'],
    })
    qc2.close()

    const second = (await (await fetch(`${baseUrl}/api/tasks`)).json()) as TasksBody
    const target2 = second.tasks.find((t) => t.id === 't-target')
    expect(target2?.blockedBy).toEqual([])
  })

  it('preserves existing task fields and creation ordering', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, 't-1', 'queued', '2026-05-20T09:00:00.000Z')
    await insertTask(qc, 't-2', 'running', '2026-05-20T09:00:01.000Z')
    await insertTask(qc, 't-3', 'blocked', '2026-05-20T09:00:02.000Z')
    await insertBlocker(qc, 't-3', 't-1')
    qc.close()

    const res = await fetch(`${baseUrl}/api/tasks`)
    const body = (await res.json()) as {
      tasks: Array<{
        id: string
        prompt: string
        status: string
        recoverySpawnedCount: number
        blockedBy: string[]
        createdAt: string
      }>
    }
    const ids = body.tasks.map((t) => t.id)
    expect(ids).toEqual(['t-1', 't-2', 't-3'])

    const t3 = body.tasks.find((t) => t.id === 't-3')
    expect(t3?.status).toBe('blocked')
    expect(t3?.prompt).toBe('prompt for t-3')
    expect(t3?.recoverySpawnedCount).toBe(0)
    expect(t3?.blockedBy).toEqual(['t-1'])
    expect(typeof t3?.createdAt).toBe('string')
  })
})
