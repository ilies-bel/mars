import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@libsql/client'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-mig-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('schema migration: drop blocker_id + task_suggestions, rename origin->source', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('migrates a legacy DB end-to-end', async () => {
    // Set up legacy queue.db schema (with blocker_id + task_suggestions).
    const queueDb = `file:${repo}/.mars/queue.db`
    const stateDb = `file:${repo}/.mars/state.db`
    const q = createClient({ url: queueDb })
    await q.execute(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
      plan_functional TEXT, plan_technical TEXT, branch TEXT, worktree_path TEXT,
      claude_session_id TEXT, error TEXT, drop_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0, blocker_id TEXT,
      fix_for_task_id TEXT, failure_signature TEXT, origin_id TEXT,
      author_kind TEXT, author_name TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    await q.execute(`CREATE TABLE task_suggestions (
      id TEXT PRIMARY KEY, source_task_id TEXT NOT NULL, title TEXT NOT NULL,
      prompt TEXT NOT NULL, rationale TEXT, status TEXT NOT NULL DEFAULT 'proposed',
      kind TEXT NOT NULL DEFAULT 'reflection', created_task_id TEXT,
      failure_signature TEXT, created_at TEXT NOT NULL
    )`)
    const now = new Date().toISOString()
    await q.execute({
      sql: `INSERT INTO tasks (id, prompt, status, retry_count, blocker_id, origin_id, created_at, updated_at) VALUES ('src-task', 'do thing', 'blocked', 1, 'sug-fix', 'src-task', ?, ?)`,
      args: [now, now],
    })
    await q.execute({
      sql: `INSERT INTO tasks (id, prompt, status, retry_count, origin_id, created_at, updated_at) VALUES ('fix-task', 'fix thing', 'queued', 0, 'fix-task', ?, ?)`,
      args: [now, now],
    })
    await q.execute({
      sql: `INSERT INTO task_suggestions (id, source_task_id, title, prompt, status, kind, created_task_id, created_at) VALUES ('sug-fix', 'src-task', 'fix it', 'fix prompt', 'promoted', 'fix', 'fix-task', ?)`,
      args: [now],
    })
    await q.execute({
      sql: `INSERT INTO task_suggestions (id, source_task_id, title, prompt, rationale, status, kind, created_at) VALUES ('sug-refl', 'src-task', 'invest cache misses', 'long prompt body', 'rationale here', 'proposed', 'reflection', ?)`,
      args: [now],
    })

    // Set up legacy state.db schema (ideas with origin column).
    const s = createClient({ url: stateDb })
    await s.execute(`CREATE TABLE ideas (
      id TEXT PRIMARY KEY, goal TEXT NOT NULL, story TEXT NOT NULL DEFAULT '',
      technical TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
      origin TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`)
    const nowMs = Date.now()
    await s.execute({
      sql: `INSERT INTO ideas (id, goal, origin, created_at, updated_at) VALUES ('idea-h', 'human goal', 'user', ?, ?)`,
      args: [nowMs, nowMs],
    })
    await s.execute({
      sql: `INSERT INTO ideas (id, goal, origin, created_at, updated_at) VALUES ('idea-a', 'agent goal', 'agent', ?, ?)`,
      args: [nowMs, nowMs],
    })

    q.close()
    s.close()

    // Trigger the migration via initProposals (which calls initQueue first).
    const { initProposals } = await import('../proposals')
    await initProposals()

    // Re-open with fresh clients.
    const q2 = createClient({ url: queueDb })
    const s2 = createClient({ url: stateDb })

    const tCols = await q2.execute(`PRAGMA table_info(tasks)`)
    const tColNames = (tCols.rows as unknown as Array<{ name: string }>).map(
      (r) => r.name,
    )
    expect(tColNames).not.toContain('blocker_id')

    const sugTable = await q2.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_suggestions'`,
    )
    expect(sugTable.rows).toHaveLength(0)

    const blockers = await q2.execute(
      `SELECT task_id, blocker_task_id FROM task_blockers ORDER BY task_id`,
    )
    expect(blockers.rows).toHaveLength(1)
    expect(blockers.rows[0]).toMatchObject({
      task_id: 'src-task',
      blocker_task_id: 'fix-task',
    })

    const ideaCols = await s2.execute(`PRAGMA table_info(proposals)`)
    const ideaColNames = (ideaCols.rows as unknown as Array<{ name: string }>).map(
      (r) => r.name,
    )
    expect(ideaColNames).toContain('source')
    expect(ideaColNames).not.toContain('origin')

    const ideaRows = await s2.execute(
      `SELECT id, title, source FROM proposals ORDER BY id`,
    )
    const idMap = new Map(
      (
        ideaRows.rows as unknown as Array<{
          id: string
          title: string
          source: string
        }>
      ).map((r) => [r.id, r]),
    )
    expect(idMap.get('idea-h')?.source).toBe('human')
    expect(idMap.get('idea-a')?.source).toBe('planner')
    // The reflection-kind suggestion landed in ideas with source='reflection'.
    expect(idMap.get('sug-refl')?.source).toBe('reflection')
    expect(idMap.get('sug-refl')?.title).toBe('invest cache misses')
    // The legacy goal column was backfilled into title for pre-existing rows.
    expect(idMap.get('idea-h')?.title).toBe('human goal')
    expect(idMap.get('idea-a')?.title).toBe('agent goal')
    // The fix-kind suggestion is vestigial; not migrated.
    expect(idMap.has('sug-fix')).toBe(false)

    q2.close()
    s2.close()
  })
})
