import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'

import { startServer } from './index.ts'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-task-detail-test-'))
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

describe('GET /api/tasks/:id', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    const queueDbPath = resolve(repo, '.mars/mars.db')
    const stateDbPath = resolve(repo, '.mars/mars.db')
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

  it('returns 404 with not_found error for an id that does not exist', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/does-not-exist`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string; id: string }
    expect(body.error).toBe('not_found')
    expect(body.id).toBe('does-not-exist')
  })

  it('returns 200 with the task when the id exists', async () => {
    const qc = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertTask(qc, 'task-1', 'queued')
    qc.close()

    const res = await fetch(`${baseUrl}/api/tasks/task-1`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: { id: string; status: string } }
    expect(body.task.id).toBe('task-1')
    expect(body.task.status).toBe('queued')
  })
})
