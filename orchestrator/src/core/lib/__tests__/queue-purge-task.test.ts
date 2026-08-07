/**
 * Tests for the purge path: dropTask (the shared cleanup-then-delete helper)
 * must remove every row that references the deleted task — task_blockers edges
 * (incoming and outgoing), task_proposal_blockers edges, and fix_for_task_id
 * pointers on siblings — all in one atomic step, leaving no dangling FK
 * references and no SQLITE_CONSTRAINT FOREIGN KEY errors.
 *
 * These tests exercise dropTask directly because both handlePurge (server.ts)
 * and handleDrop (server.ts) route through it. The status precondition
 * (failed/done only for purge; any status with force for drop) is enforced
 * upstream in the handlers and is not re-tested here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  addBlockers: typeof import('../../queue').addBlockers
  addProposalBlockers: typeof import('../../queue').addProposalBlockers
  listProposalBlockers: typeof import('../../queue').listProposalBlockers
  dropTask: typeof import('../../queue').dropTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-purge-task-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string): Promise<QueueModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  return q
}

/**
 * task_proposal_blockers carries a real FK on proposal_id (ADR-0034),
 * so any test that adds a proposal-blocker edge must first materialise
 * the referenced proposal row. The proposals table is created by
 * migrateQueueSchema (minimal shape, sufficient for the FK target).
 */
const seedProposals = async (
  q: QueueModule,
  ids: string[],
): Promise<void> => {
  const now = Date.now()
  for (const id of ids) {
    await q.resolveQueueClient().execute({
      sql: `INSERT OR IGNORE INTO proposals (id, created_at, updated_at)
            VALUES (?, ?, ?)`,
      args: [id, now, now],
    })
  }
}

describe('dropTask (shared purge/drop helper) — edge cleanup', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── task_proposal_blockers ────────────────────────────────────────────────

  it('removes task_proposal_blockers edges when the task is deleted', async () => {
    const q = await loadQueue(repo)
    // A failed task blocked by a proposal — this is the scenario that previously
    // triggered SQLITE_CONSTRAINT FOREIGN KEY when handlePurge called deleteTask.
    const task = await q.enqueueTask('blocked by proposal', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'failed', error: 'test' })

    // Add a proposal-blocker edge: task_id FK → tasks(id) enforces a constraint.
    await seedProposals(q, ['prop-abc123'])
    await q.addProposalBlockers(task.id, ['prop-abc123'])

    // Before: edge exists.
    expect(await q.listProposalBlockers(task.id)).toEqual(['prop-abc123'])

    // dropTask must remove the task_proposal_blockers row before deleting the
    // task row, otherwise SQLITE_CONSTRAINT FOREIGN KEY fires.
    await expect(q.dropTask(task.id)).resolves.toMatchObject({
      taskId: task.id,
      previousStatus: 'failed',
    })

    // After: task is gone, no stale edge rows remain.
    expect(await q.getTask(task.id)).toBeNull()
    const leftover = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_proposal_blockers WHERE task_id = ?`,
      args: [task.id],
    })
    expect(
      Number((leftover.rows[0] as unknown as { n: number | bigint }).n),
    ).toBe(0)
  })

  it('removes proposal-blocker edges for a done task without raising a constraint error', async () => {
    const q = await loadQueue(repo)
    const task = await q.enqueueTask('done task with proposal edge', undefined, {
      skipTriage: true,
    })
    await q.updateTask(task.id, { status: 'done' })
    await seedProposals(q, ['prop-xyz999', 'prop-abc000'])
    await q.addProposalBlockers(task.id, ['prop-xyz999', 'prop-abc000'])

    await expect(q.dropTask(task.id)).resolves.toMatchObject({
      taskId: task.id,
      previousStatus: 'done',
    })

    expect(await q.getTask(task.id)).toBeNull()
    const leftover = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_proposal_blockers WHERE task_id = ?`,
      args: [task.id],
    })
    expect(
      Number((leftover.rows[0] as unknown as { n: number | bigint }).n),
    ).toBe(0)
  })

  // ── task_blockers (incoming / outgoing) ───────────────────────────────────

  it('removes incoming task_blockers edges (other tasks waiting on the purged task)', async () => {
    const q = await loadQueue(repo)
    const blocker = await q.enqueueTask('blocker task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(blocker.id, { status: 'failed', error: 'test' })
    const waiter = await q.enqueueTask('waiting on blocker', undefined, {
      skipTriage: true,
    })
    // waiter is blocked by blocker → blocker has an incoming edge
    await q.addBlockers(waiter.id, [blocker.id])

    const result = await q.dropTask(blocker.id)

    expect(result.taskId).toBe(blocker.id)
    expect(result.edgesRemoved.incoming).toBe(1)
    expect(result.edgesRemoved.outgoing).toBe(0)
    expect(await q.getTask(blocker.id)).toBeNull()

    // waiter still exists and its task_blockers row has been removed.
    expect(await q.getTask(waiter.id)).not.toBeNull()
    const leftover = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE blocker_task_id = ?`,
      args: [blocker.id],
    })
    expect(
      Number((leftover.rows[0] as unknown as { n: number | bigint }).n),
    ).toBe(0)
  })

  it('removes outgoing task_blockers edges (the purged task was waiting on others)', async () => {
    const q = await loadQueue(repo)
    const dep1 = await q.enqueueTask('dep1', undefined, { skipTriage: true })
    const dep2 = await q.enqueueTask('dep2', undefined, { skipTriage: true })
    const waiter = await q.enqueueTask('failed waiter', undefined, {
      skipTriage: true,
    })
    await q.updateTask(waiter.id, { status: 'failed', error: 'test' })
    await q.addBlockers(waiter.id, [dep1.id, dep2.id])

    const result = await q.dropTask(waiter.id)

    expect(result.edgesRemoved.outgoing).toBe(2)
    expect(result.edgesRemoved.incoming).toBe(0)
    expect(await q.getTask(waiter.id)).toBeNull()

    // Dependencies still exist and their blocker rows are gone.
    expect(await q.getTask(dep1.id)).not.toBeNull()
    expect(await q.getTask(dep2.id)).not.toBeNull()
    const leftover = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
      args: [waiter.id],
    })
    expect(
      Number((leftover.rows[0] as unknown as { n: number | bigint }).n),
    ).toBe(0)
  })

  // ── fix_for_task_id cascade deletion (ADR-0049) ───────────────────────────

  it('cascade-deletes fix tasks that point at the deleted origin (ADR-0049)', async () => {
    const q = await loadQueue(repo)
    // Parent task: the target of purge.
    const parent = await q.enqueueTask('parent task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(parent.id, { status: 'failed', error: 'test' })

    // Directly insert a fix row that has fix_for_task_id = parent.id.
    // (enqueueTask doesn't expose fix_for_task_id; write it raw.)
    const c = q.resolveQueueClient()
    const siblingId = 'mars-sibling01'
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, kind, origin_id, priority, created_at, updated_at, recovery_spawned_count)
            VALUES (?, ?, 'queued', ?, 'fix', ?, 0, datetime('now'), datetime('now'), 0)`,
      args: [siblingId, 'fix for parent', parent.id, parent.id],
    })

    const result = await q.dropTask(parent.id)
    // ADR-0049: cascade-deleted, not null-ed.
    expect(result.cascadedFixTaskIds).toContain(siblingId)

    // Fix task row is GONE — not surviving with a null pointer.
    expect(await q.getTask(siblingId)).toBeNull()
  })

  // ── combined: all edge types at once ─────────────────────────────────────

  it('handles all edge types simultaneously in one atomic step', async () => {
    const q = await loadQueue(repo)
    const target = await q.enqueueTask('target task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(target.id, { status: 'failed', error: 'test' })

    // Outgoing: target waits on dependency.
    const dep = await q.enqueueTask('dependency', undefined, { skipTriage: true })
    await q.addBlockers(target.id, [dep.id])

    // Incoming: waiter is blocked by target.
    const waiter = await q.enqueueTask('waiter', undefined, { skipTriage: true })
    await q.addBlockers(waiter.id, [target.id])

    // Proposal blocker: target is also gated on a proposal.
    await seedProposals(q, ['prop-combined'])
    await q.addProposalBlockers(target.id, ['prop-combined'])

    // Sibling fix_for pointer: another task points back at target.
    const c = q.resolveQueueClient()
    const sibId = 'mars-sibling02'
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, kind, origin_id, priority, created_at, updated_at, recovery_spawned_count)
            VALUES (?, ?, 'queued', ?, 'fix', ?, 0, datetime('now'), datetime('now'), 0)`,
      args: [sibId, 'fix sibling', target.id, target.id],
    })

    const result = await q.dropTask(target.id)

    // Target is gone.
    expect(await q.getTask(target.id)).toBeNull()
    // Edge counts.
    expect(result.edgesRemoved.incoming).toBe(1)
    expect(result.edgesRemoved.outgoing).toBe(1)
    // ADR-0049: fix task is cascade-deleted.
    expect(result.cascadedFixTaskIds).toContain(sibId)

    // No task_blockers rows mention target on either side.
    const tbLeft = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ? OR blocker_task_id = ?`,
      args: [target.id, target.id],
    })
    expect(Number((tbLeft.rows[0] as unknown as { n: number | bigint }).n)).toBe(0)

    // No task_proposal_blockers rows remain for target.
    const tpbLeft = await q.resolveQueueClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_proposal_blockers WHERE task_id = ?`,
      args: [target.id],
    })
    expect(Number((tpbLeft.rows[0] as unknown as { n: number | bigint }).n)).toBe(0)

    // Fix task row is GONE — cascade-deleted with the origin (ADR-0049).
    expect(await q.getTask(sibId)).toBeNull()
  })
})
