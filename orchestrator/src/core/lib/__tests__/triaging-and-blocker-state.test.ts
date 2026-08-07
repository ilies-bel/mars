import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@libsql/client'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * PRD 2be831da slice 1 — Triaging status, polymorphic Blocker rows with
 * `state`, and removal of `actionable`/`reason` from the Task record.
 *
 * Tests stay on the public queue interface; they assert observable
 * behaviour through the surface that the dispatcher / linker / writers see.
 */

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-triaging-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('Triaging status + Blocker state schema', () => {
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

  it('initialises the tasks schema with no `actionable` column and no `reason` column', async () => {
    const { migrateQueueSchema } = await import('../../queue')
    await migrateQueueSchema()

    const c = createClient({ url: `file:${repo}/.mars/mars.db` })
    try {
      const cols = await c.execute(`PRAGMA table_info(tasks)`)
      const names = new Set(
        cols.rows.map((row) => (row as unknown as { name: string }).name),
      )
      expect(names.has('actionable')).toBe(false)
      expect(names.has('reason')).toBe(false)
    } finally {
      c.close()
    }
  })

  it('treats `triaging` as a valid status that is NOT dispatchable', async () => {
    const { isDispatchableStatus } = await import('../../queue')
    expect(isDispatchableStatus('triaging')).toBe(false)
    expect(isDispatchableStatus('queued')).toBe(true)
    expect(isDispatchableStatus('draft')).toBe(false)
  })

  it('persists a freshly-promoted Task with status=triaging', async () => {
    const { migrateQueueSchema, resolveQueueClient } = await import('../../queue')
    await migrateQueueSchema()
    const now = new Date().toISOString()
    const c = resolveQueueClient()
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, kind, priority, tag, created_at, updated_at)
            VALUES (?, ?, 'triaging', ?, 0, 'task', 0, 'coder', ?, ?)`,
      args: ['t-triaging', 'do thing', 't-triaging', now, now],
    })
    const r = await c.execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: ['t-triaging'],
    })
    expect((r.rows[0] as unknown as { status: string }).status).toBe('triaging')
  })

  it('defaults causal addBlockers writes to state=confirmed', async () => {
    const { migrateQueueSchema, addBlockers, resolveQueueClient } = await import('../../queue')
    await migrateQueueSchema()
    const now = new Date().toISOString()
    const c = resolveQueueClient()
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, kind, priority, tag, created_at, updated_at)
            VALUES ('a', 'a', 'queued', 'a', 0, 'task', 0, 'coder', ?, ?)`,
      args: [now, now],
    })
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, kind, priority, tag, created_at, updated_at)
            VALUES ('b', 'b', 'queued', 'b', 0, 'task', 0, 'coder', ?, ?)`,
      args: [now, now],
    })
    await addBlockers('a', ['b'])
    const r = await c.execute({
      sql: `SELECT state FROM task_blockers WHERE task_id = 'a' AND blocker_task_id = 'b'`,
    })
    expect((r.rows[0] as unknown as { state: string }).state).toBe('confirmed')
  })

  it('records pending-review state via addPendingReviewBlockers', async () => {
    const { migrateQueueSchema, addPendingReviewBlockers, resolveQueueClient } = await import(
      '../../queue'
    )
    await migrateQueueSchema()
    const now = new Date().toISOString()
    const c = resolveQueueClient()
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, kind, priority, tag, created_at, updated_at)
            VALUES ('a', 'a', 'triaging', 'a', 0, 'task', 0, 'coder', ?, ?)`,
      args: [now, now],
    })
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, kind, priority, tag, created_at, updated_at)
            VALUES ('b', 'b', 'queued', 'b', 0, 'task', 0, 'coder', ?, ?)`,
      args: [now, now],
    })
    await addPendingReviewBlockers('a', ['b'])
    const r = await c.execute({
      sql: `SELECT state FROM task_blockers WHERE task_id = 'a' AND blocker_task_id = 'b'`,
    })
    expect((r.rows[0] as unknown as { state: string }).state).toBe(
      'pending-review',
    )
  })

  it('rejected Blocker rows do NOT gate the dispatcher', async () => {
    const { migrateQueueSchema, addBlockers, listBlockers, hasIncompleteBlockers, resolveQueueClient } =
      await import('../../queue')
    await migrateQueueSchema()
    const now = new Date().toISOString()
    const c = resolveQueueClient()
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, kind, priority, tag, created_at, updated_at)
            VALUES ('a', 'a', 'queued', 'a', 0, 'task', 0, 'coder', ?, ?)`,
      args: [now, now],
    })
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, kind, priority, tag, created_at, updated_at)
            VALUES ('b', 'b', 'queued', 'b', 0, 'task', 0, 'coder', ?, ?)`,
      args: [now, now],
    })
    await addBlockers('a', ['b'])
    // Manually mark the blocker rejected — the deterministic Linker will
    // own this transition in a later slice; tests exercise it directly here.
    await c.execute({
      sql: `UPDATE task_blockers SET state = 'rejected' WHERE task_id = 'a' AND blocker_task_id = 'b'`,
    })
    expect(await listBlockers('a')).toEqual([])
    expect(await hasIncompleteBlockers('a')).toBe(false)
  })

  it('parks a queued dependent with an incomplete blocker as blocked, then re-queues it when the blocker completes', async () => {
    // Reproduces the daemon dispatcher invariant (server.ts dispatchTriage):
    // an actionable, queued task that still has an incomplete blocker must be
    // flipped to 'blocked', not left 'queued' — otherwise the unblock
    // machinery (which only scans status='blocked') never re-evaluates it.
    const { migrateQueueSchema, addBlockers, hasIncompleteBlockers, updateTask, resolveQueueClient } =
      await import('../../queue')
    const { Arc } = await import('../../arc')
    await migrateQueueSchema()
    const now = new Date().toISOString()
    const c = resolveQueueClient()
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, kind, priority, tag, created_at, updated_at)
            VALUES ('dep', 'dependent', 'queued', 'dep', 0, 'task', 0, 'coder', ?, ?)`,
      args: [now, now],
    })
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, kind, priority, tag, created_at, updated_at)
            VALUES ('blk', 'blocker', 'queued', 'blk', 0, 'task', 0, 'coder', ?, ?)`,
      args: [now, now],
    })
    await addBlockers('dep', ['blk'])

    // The dispatcher's guard: incomplete blocker present → park 'blocked'.
    expect(await hasIncompleteBlockers('dep')).toBe(true)
    await updateTask('dep', { status: 'blocked' })

    const blocked = await c.execute({
      sql: `SELECT status FROM tasks WHERE id = 'dep'`,
    })
    expect((blocked.rows[0] as unknown as { status: string }).status).toBe(
      'blocked',
    )

    // Blocker completes → Arc.unblockByCompletion re-queues the dependent.
    await updateTask('blk', { status: 'done' })
    await Arc.unblockByCompletion('blk')

    const requeued = await c.execute({
      sql: `SELECT status FROM tasks WHERE id = 'dep'`,
    })
    expect((requeued.rows[0] as unknown as { status: string }).status).toBe(
      'queued',
    )
  })

  it('returns task-cause and idea-cause Blocker rows uniformly from listAllBlockers', async () => {
    const { migrateQueueSchema, addBlockers, addProposalBlockers, listAllBlockers, resolveQueueClient } =
      await import('../../queue')
    await migrateQueueSchema()
    const now = new Date().toISOString()
    const c = resolveQueueClient()
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, kind, priority, tag, created_at, updated_at)
            VALUES ('a', 'a', 'queued', 'a', 0, 'task', 0, 'coder', ?, ?)`,
      args: [now, now],
    })
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, recovery_spawned_count, kind, priority, tag, created_at, updated_at)
            VALUES ('b', 'b', 'queued', 'b', 0, 'task', 0, 'coder', ?, ?)`,
      args: [now, now],
    })
    await addBlockers('a', ['b'])
    // ADR-0034: task_proposal_blockers.proposal_id is a real FK, so
    // seed a proposal row before the blocker insert.
    await c.execute({
      sql: `INSERT OR IGNORE INTO proposals (id, created_at, updated_at)
            VALUES ('idea-xyz', ?, ?)`,
      args: [Date.now(), Date.now()],
    })
    await addProposalBlockers('a', ['idea-xyz'])

    const blockers = await listAllBlockers('a')
    expect(blockers).toHaveLength(2)
    const kinds = blockers.map((b) => b.causeKind).sort()
    expect(kinds).toEqual(['idea', 'task'])
    const taskBlocker = blockers.find((b) => b.causeKind === 'task')
    const ideaBlocker = blockers.find((b) => b.causeKind === 'idea')
    expect(taskBlocker?.causeId).toBe('b')
    expect(taskBlocker?.state).toBe('confirmed')
    expect(ideaBlocker?.causeId).toBe('idea-xyz')
    expect(ideaBlocker?.state).toBe('confirmed')
  })

  it('migrates a legacy task_blockers row (no state column) into state=confirmed', async () => {
    // Set up a legacy queue.db that predates the `state` column.
    const queueDb = `file:${repo}/.mars/mars.db`
    const q = createClient({ url: queueDb })
    await q.execute(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL,
      recovery_spawned_count INTEGER NOT NULL DEFAULT 0, origin_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    await q.execute(`CREATE TABLE task_blockers (
      task_id TEXT NOT NULL,
      blocker_task_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, blocker_task_id)
    )`)
    const now = new Date().toISOString()
    await q.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, created_at, updated_at) VALUES ('a', 'a', 'blocked', 'a', ?, ?)`,
      args: [now, now],
    })
    await q.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, created_at, updated_at) VALUES ('b', 'b', 'queued', 'b', ?, ?)`,
      args: [now, now],
    })
    await q.execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES ('a', 'b', ?)`,
      args: [now],
    })
    q.close()

    const { migrateQueueSchema } = await import('../../queue')
    await migrateQueueSchema()

    const c = createClient({ url: queueDb })
    try {
      const r = await c.execute(
        `SELECT state FROM task_blockers WHERE task_id = 'a' AND blocker_task_id = 'b'`,
      )
      expect((r.rows[0] as unknown as { state: string }).state).toBe(
        'confirmed',
      )
    } finally {
      c.close()
    }
  })

  it('promoteDraftToTriaging advances a draft task into triaging', async () => {
    const { migrateQueueSchema, enqueueTask, promoteDraftToTriaging } = await import(
      '../../queue'
    )
    await migrateQueueSchema()
    const t = await enqueueTask('do a thing')
    expect(t.status).toBe('draft')

    const triaging = await promoteDraftToTriaging(t.id)
    expect(triaging).not.toBeNull()
    expect(triaging!.status).toBe('triaging')
  })

  it('promoteDraftToTriaging is a no-op when the task is not in draft', async () => {
    const { migrateQueueSchema, enqueueTask, promoteDraftToTriaging } = await import(
      '../../queue'
    )
    await migrateQueueSchema()
    const t = await enqueueTask('do another thing', undefined, { skipTriage: true })
    // Task lands in 'queued', not 'draft' — promote should return null.
    expect(t.status).toBe('queued')
    const result = await promoteDraftToTriaging(t.id)
    expect(result).toBeNull()
  })

  it('promoteDraftToQueued accepts a triaging task once blockers are clear', async () => {
    const { migrateQueueSchema, enqueueTask, promoteDraftToTriaging, promoteDraftToQueued } =
      await import('../../queue')
    await migrateQueueSchema()
    const t = await enqueueTask('do yet another thing')
    await promoteDraftToTriaging(t.id)

    const queued = await promoteDraftToQueued(t.id)
    expect(queued).not.toBeNull()
    expect(queued!.status).toBe('queued')
  })
})
