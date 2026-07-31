/**
 * Tests for the /api/todo endpoint, specifically the stale-worktree
 * actionQueue items slice: items raised by the daemon's stale-worktree sweep
 * are readable from mars.db via StateDb and returned to the web UI's
 * Alerts section, satisfying "visible identically across CLI, skill,
 * and web UI".
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient } from '@libsql/client'
import { startServer } from './index.ts'
import { makeDaemonStub } from './testDaemonStub.ts'

interface TodoBody {
  drafts: unknown[]
  staleWorktrees: Array<{
    taskId: string
    status: string
    ageHours: number
    updatedAt: string
    prompt: string
    error: string | null
    branch: string | null
    blockerTaskId: string | null
  }>
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-todo-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const seedActionQueueItems = async (stateDbPath: string): Promise<void> => {
  const c = createClient({ url: `file:${stateDbPath}` })
  await c.execute(`PRAGMA journal_mode = WAL`)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS action_queue_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      category TEXT NOT NULL,
      priority TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      context TEXT NOT NULL DEFAULT '{}',
      raised_by TEXT NOT NULL,
      raised_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolution TEXT,
      resolution_note TEXT,
      root_cause TEXT,
      fingerprint TEXT,
      signature TEXT,
      seen_count INTEGER NOT NULL DEFAULT 1,
      last_seen_at INTEGER,
      resolved_by TEXT
    )
  `)
  c.close()
}

const insertStaleWorktreeItem = async (
  stateDbPath: string,
  opts: {
    id: string
    taskId: string
    status?: string
    ageHours?: number
    prompt?: string
    branch?: string | null
    error?: string | null
    state?: string
  },
): Promise<void> => {
  const {
    id,
    taskId,
    status = 'running',
    ageHours = 48,
    prompt = 'some task prompt',
    branch = null,
    error = null,
    state = 'open',
  } = opts
  const now = Date.now()
  const fp = `origin-${taskId}`
  const payload = JSON.stringify({ ageHours, status, branch, prompt, error })
  const context = JSON.stringify({ taskId })
  const c = createClient({ url: `file:${stateDbPath}` })
  await c.execute({
    sql: `INSERT INTO action_queue_items (
      id, kind, category, priority, state, title, body, payload, context,
      raised_by, raised_at, last_seen_at, seen_count, fingerprint, signature
    ) VALUES (?, 'stale-worktree', 'daemon', 'normal', ?, ?, '', ?, ?, ?,  ?, ?, 1, ?, ?)`,
    args: [
      id,
      state,
      `Stale worktree: task ${taskId}`,
      payload,
      context,
      'daemon:stale-worktree-sweep',
      now,
      now,
      fp,
      taskId,
    ],
  })
  c.close()
}

describe('GET /api/stale-worktrees — stale-worktree actionQueue items', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string
  let stateDbPath: string

  beforeEach(async () => {
    repo = setupRepo()
    stateDbPath = resolve(repo, '.mars/mars.db')
    await seedActionQueueItems(stateDbPath)

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

  it('returns an open stale-worktree actionQueue item in staleWorktrees', async () => {
    await insertStaleWorktreeItem(stateDbPath, {
      id: 'itest-1',
      taskId: 'task-abc',
      status: 'running',
      ageHours: 48,
      prompt: 'fix the login bug',
      branch: 'task/task-abc',
    })

    const res = await fetch(`${baseUrl}/api/stale-worktrees`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as TodoBody

    expect(Array.isArray(body.staleWorktrees)).toBe(true)
    expect(body.staleWorktrees).toHaveLength(1)

    const item = body.staleWorktrees[0]
    expect(item.taskId).toBe('task-abc')
    expect(item.status).toBe('running')
    expect(item.ageHours).toBe(48)
    expect(item.prompt).toBe('fix the login bug')
    expect(item.branch).toBe('task/task-abc')
    expect(item.error).toBeNull()
    expect(item.blockerTaskId).toBeNull()
  })

  it('omits resolved stale-worktree items (only open items appear)', async () => {
    await insertStaleWorktreeItem(stateDbPath, {
      id: 'itest-open',
      taskId: 'task-open',
      state: 'open',
    })
    await insertStaleWorktreeItem(stateDbPath, {
      id: 'itest-resolved',
      taskId: 'task-resolved',
      state: 'resolved',
    })

    const res = await fetch(`${baseUrl}/api/stale-worktrees`)
    const body = (await res.json()) as TodoBody

    expect(body.staleWorktrees).toHaveLength(1)
    expect(body.staleWorktrees[0].taskId).toBe('task-open')
  })

  it('returns an empty staleWorktrees array when no actionQueue items exist', async () => {
    const res = await fetch(`${baseUrl}/api/stale-worktrees`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as TodoBody
    expect(Array.isArray(body.staleWorktrees)).toBe(true)
    expect(body.staleWorktrees).toHaveLength(0)
  })
})
