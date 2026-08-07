import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient } from '@libsql/client'

import { startServer } from './index.ts'
import { makeDaemonStub } from './testDaemonStub.ts'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-task-detail-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const seedTask = async (dbPath: string, id: string, status: string): Promise<void> => {
  const c = createClient({ url: `file:${dbPath}` })
  try {
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
      recovery_spawned_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    const now = new Date().toISOString()
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, recovery_spawned_count, created_at, updated_at)
            VALUES (?, ?, ?, 0, ?, ?)`,
      args: [id, `prompt for ${id}`, status, now, now],
    })
  } finally {
    c.close()
  }
}

describe('GET /api/tasks/:id — proxies daemon /view/tasks/:id', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string
  let dbPath: string

  beforeEach(async () => {
    repo = setupRepo()
    dbPath = resolve(repo, '.mars/mars.db')

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

  it('returns 404 with not_found error for an id that does not exist', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/does-not-exist`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string; id: string }
    expect(body.error).toBe('not_found')
    expect(body.id).toBe('does-not-exist')
  })

  it('returns 200 with the task when the id exists', async () => {
    await seedTask(dbPath, 'task-1', 'queued')

    const res = await fetch(`${baseUrl}/api/tasks/task-1`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: { id: string; status: string } }
    expect(body.task.id).toBe('task-1')
    expect(body.task.status).toBe('queued')
  })
})
