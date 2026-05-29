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
    const queueDb = `file:${repo}/.mars/mars.db`
    const stateDb = `file:${repo}/.mars/mars.db`
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

describe('integration_head_sha column', () => {
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

  it('initQueue adds integration_head_sha column to tasks table', async () => {
    const { initQueue } = await import('../queue')
    await initQueue()

    const q = createClient({ url: `file:${repo}/.mars/mars.db` })
    const cols = await q.execute(`PRAGMA table_info(tasks)`)
    const colNames = (cols.rows as unknown as Array<{ name: string }>).map(
      (r) => r.name,
    )
    expect(colNames).toContain('integration_head_sha')
    q.close()
  })

  it('updateTask + getTask round-trip a valid 40-char SHA', async () => {
    const { initQueue, enqueueTask, updateTask, getTask } = await import('../queue')
    await initQueue()

    const task = await enqueueTask('test prompt', undefined, { skipTriage: true })
    const fakeSha = 'a'.repeat(40)
    await updateTask(task.id, { integrationHeadSha: fakeSha })

    const loaded = await getTask(task.id)
    expect(loaded?.integrationHeadSha).toBe(fakeSha)
  })

  it('tasks without integration_head_sha load with null', async () => {
    const { initQueue, enqueueTask, getTask } = await import('../queue')
    await initQueue()

    const task = await enqueueTask('test prompt 2', undefined, { skipTriage: true })
    const loaded = await getTask(task.id)
    expect(loaded?.integrationHeadSha).toBeNull()
  })

  it('migrates a legacy DB that has no integration_head_sha column', async () => {
    const queueDb = `file:${repo}/.mars/mars.db`
    const q = createClient({ url: queueDb })
    // Create a legacy tasks table without integration_head_sha
    await q.execute(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
      origin_id TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    const now = new Date().toISOString()
    await q.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, retry_count, created_at, updated_at)
            VALUES ('legacy-task', 'old task', 'done', 'legacy-task', 0, ?, ?)`,
      args: [now, now],
    })
    q.close()

    // Run migration
    const { initQueue, getTask } = await import('../queue')
    await initQueue()

    // Legacy task loads without error; integration_head_sha is null
    const loaded = await getTask('legacy-task')
    expect(loaded).not.toBeNull()
    expect(loaded?.integrationHeadSha).toBeNull()
  })
})

describe('schema bootstrap: task_proposal_blockers table + indexes', () => {
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

  it('creates task_proposal_blockers with task_id/proposal_id/created_at and proposal-side index', async () => {
    const { initQueue } = await import('../queue')
    await initQueue()

    const q = createClient({ url: `file:${repo}/.mars/mars.db` })

    // Table exists
    const tableRow = await q.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_proposal_blockers'`,
    )
    expect(tableRow.rows).toHaveLength(1)

    // Correct columns
    const cols = await q.execute(`PRAGMA table_info(task_proposal_blockers)`)
    const colNames = (cols.rows as unknown as Array<{ name: string }>).map(
      (r) => r.name,
    )
    expect(colNames).toContain('task_id')
    expect(colNames).toContain('proposal_id')
    expect(colNames).toContain('created_at')

    // Index on proposal_id for the "which tasks are blocked by this proposal" lookup
    const idx = await q.execute(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_task_proposal_blockers_proposal'`,
    )
    expect(idx.rows).toHaveLength(1)

    q.close()
  })
})

describe('migration: task_signals + task_transcripts → trace_events (PRD 436f14c7 slice 5)', () => {
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

  it('copies task_signals rows into trace_events and drops the table', async () => {
    const dbPath = `file:${repo}/.mars/mars.db`
    const q = createClient({ url: dbPath })
    const now = '2025-01-01T00:00:00.000Z'

    // Seed a minimal tasks table so the migration can look up origin_id.
    await q.execute(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
      origin_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    await q.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: ['task-a', 'do thing', 'done', 'task-a', now, now],
    })

    // Create legacy task_signals.
    await q.execute(`CREATE TABLE task_signals (
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (task_id, step_id)
    )`)
    await q.execute({
      sql: `INSERT INTO task_signals VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['task-a', 'run-claude-code', 1000, 500, 200, 100, 5, now],
    })
    q.close()

    // Run the migration.
    const { initQueue } = await import('../queue')
    await initQueue()

    const db = createClient({ url: dbPath })

    // task_signals must be gone.
    const sigTable = await db.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_signals'`,
    )
    expect(sigTable.rows).toHaveLength(0)

    // trace_events must contain the migrated row.
    const events = await db.execute(
      `SELECT * FROM trace_events WHERE id = 'migrated-sig-task-a-run-claude-code'`,
    )
    expect(events.rows).toHaveLength(1)
    const row = events.rows[0] as unknown as Record<string, unknown>
    expect(row.kind).toBe('step_ended')
    expect(row.task_id).toBe('task-a')
    expect(row.timestamp).toBe(now)
    const payload = JSON.parse(row.payload as string) as Record<string, unknown>
    expect(payload.stepName).toBe('code')
    expect(payload.outcome).toBe('success')
    expect(payload.migrated).toBe(true)
    const usage = payload.usageSignals as Record<string, unknown>
    expect(usage.inputTokens).toBe(1000)
    expect(usage.outputTokens).toBe(500)

    db.close()
  })

  it('copies task_transcripts rows into trace_events and drops the table', async () => {
    const dbPath = `file:${repo}/.mars/mars.db`
    const q = createClient({ url: dbPath })
    const now = '2025-06-01T00:00:00.000Z'

    await q.execute(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
      origin_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    await q.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: ['task-b', 'verify thing', 'done', 'task-b', now, now],
    })

    await q.execute(`CREATE TABLE task_transcripts (
      task_id TEXT PRIMARY KEY,
      conversation_json TEXT NOT NULL,
      verify_output TEXT,
      bytes INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    )`)
    await q.execute({
      sql: `INSERT INTO task_transcripts VALUES (?, ?, ?, ?, ?)`,
      args: ['task-b', '[]', 'FAIL: 1 test failed', 2, now],
    })
    q.close()

    const { initQueue } = await import('../queue')
    await initQueue()

    const db = createClient({ url: dbPath })

    // task_transcripts must be gone.
    const txTable = await db.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_transcripts'`,
    )
    expect(txTable.rows).toHaveLength(0)

    // trace_events must contain the migrated row with verifyOutput.
    const events = await db.execute(
      `SELECT * FROM trace_events WHERE id = 'migrated-tx-task-b'`,
    )
    expect(events.rows).toHaveLength(1)
    const row = events.rows[0] as unknown as Record<string, unknown>
    expect(row.kind).toBe('step_ended')
    expect(row.task_id).toBe('task-b')
    expect(row.timestamp).toBe(now)
    const payload = JSON.parse(row.payload as string) as Record<string, unknown>
    expect(payload.stepName).toBe('code')
    expect(payload.outcome).toBe('success')
    expect(payload.migrated).toBe(true)
    expect(payload.verifyOutput).toBe('FAIL: 1 test failed')

    db.close()
  })

  it('is a no-op when both legacy tables are already absent', async () => {
    // Run initQueue twice; the second run must not error even though
    // neither task_signals nor task_transcripts exists.
    const { initQueue } = await import('../queue')
    await initQueue()

    vi.resetModules()
    process.env.MARS_REPO = repo
    const { initQueue: initQueue2 } = await import('../queue')
    await expect(initQueue2()).resolves.not.toThrow()
  })

  it('pre-existing arc is still walkable by listDeepReflectArcCandidates after migration', async () => {
    const dbPath = `file:${repo}/.mars/mars.db`
    const q = createClient({ url: dbPath })
    const now = '2025-03-01T00:00:00.000Z'

    // Seed tasks.
    await q.execute(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
      origin_id TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    await q.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, retry_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ['arc-task', 'old work', 'done', 'arc-task', 0, now, now],
    })

    // Seed task_transcripts so migration produces a step_ended with transcript.
    await q.execute(`CREATE TABLE task_transcripts (
      task_id TEXT PRIMARY KEY,
      conversation_json TEXT NOT NULL,
      verify_output TEXT,
      bytes INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    )`)
    await q.execute({
      sql: `INSERT INTO task_transcripts VALUES (?, ?, ?, ?, ?)`,
      args: ['arc-task', '[{"type":"assistant"}]', null, 20, now],
    })
    q.close()

    const { initQueue } = await import('../queue')
    await initQueue()

    // task_transcripts dropped.
    const db = createClient({ url: dbPath })
    const txCheck = await db.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_transcripts'`,
    )
    expect(txCheck.rows).toHaveLength(0)

    // The arc task is still present in trace_events (migrated-tx row).
    const evts = await db.execute(
      `SELECT id FROM trace_events WHERE task_id = 'arc-task' AND kind = 'step_ended'`,
    )
    expect(evts.rows.length).toBeGreaterThan(0)
    db.close()
  })
})
