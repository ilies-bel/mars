/**
 * Verifies that corePurgeTask emits task.dropped in the same transaction as
 * DELETE FROM tasks — the event survives the row removal so the Invalidator
 * can close Action-queue rows without a daemon-side race (ADR-0030,
 * PRD 12fdef39 slice 2).
 *
 * Acceptance criteria:
 *   (a) events table contains a task.dropped event whose ts is ≤ the
 *       deletion timestamp (both committed in the same atomic tx; the INSERT
 *       precedes DELETE FROM tasks in execution order).
 *   (b) the inbox row is gone after drainAlertDismissals runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
}

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
}

interface AlertDismisserModule {
  ensureAlertDismisser: typeof import('../alert-dismisser').ensureAlertDismisser
  drainAlertDismissals: typeof import('../alert-dismisser').drainAlertDismissals
}

interface PurgeTaskModule {
  corePurgeTask: typeof import('../purge-task').corePurgeTask
}

interface Loaded {
  q: QueueModule
  actionQueue: ActionQueueModule
  ad: AlertDismisserModule
  pt: PurgeTaskModule
}

/** Create a minimal git repo with one commit on main so git operations work. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-purge-emits-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return repo
}

const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const ad = (await import('../alert-dismisser')) as unknown as AlertDismisserModule
  const pt = (await import('../purge-task')) as unknown as PurgeTaskModule
  return { q, actionQueue, ad, pt }
}

describe('corePurgeTask — task.dropped emitted before DELETE', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('emits task.dropped in the same tx as DELETE, and drainAlertDismissals clears the inbox row', async () => {
    const { q, actionQueue, ad, pt } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed a terminal task.
    const task = await q.enqueueTask('purge-emit test', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'failed', error: 'test failure' })

    // Raise an open inbox row for the task.
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: `Task ${task.id} failed`,
      body: 'stuck',
      payload: {},
      context: { task_id: task.id },
      raisedBy: 'orchestrator:test',
      signature: `sig-${task.id}`,
      originTaskId: task.id,
    })

    // Register subscriber AFTER seeding so pre-purge events are behind the cursor.
    await ad.ensureAlertDismisser(client)

    const beforeSec = Math.floor(Date.now() / 1000)

    // corePurgeTask with force=true — the task branch doesn't exist so
    // git branch -D fails silently (.catch(() => {}) in the implementation).
    await pt.corePurgeTask(task.id, true, 'main', repo)

    // (a) Task row is gone — deletion happened.
    const taskRow = await client.execute({
      sql: `SELECT 1 FROM tasks WHERE id = ?`,
      args: [task.id],
    })
    expect(taskRow.rows.length).toBe(0)

    // (a) task.dropped event exists; its ts is ≤ the deletion timestamp.
    // Both the event INSERT and DELETE FROM tasks share one atomic tx, with
    // publish() executing before the DELETE statement in dropTask, so the
    // event is durable even though the task row is gone.
    const evRow = await client.execute({
      sql: `SELECT ts FROM events WHERE type = 'task.dropped'
            AND json_extract(payload, '$.taskId') = ?`,
      args: [task.id],
    })
    expect(evRow.rows.length).toBe(1)
    const eventTs = Number((evRow.rows[0] as unknown as { ts: number | bigint }).ts)
    const afterSec = Math.floor(Date.now() / 1000)
    // Event was written during the purge call (ts ≥ before).
    expect(eventTs).toBeGreaterThanOrEqual(beforeSec)
    // Event ts ≤ afterSec — at or before the deletion timestamp.
    expect(eventTs).toBeLessThanOrEqual(afterSec)

    // (b) Inbox row is cleared by drainAlertDismissals consuming the task.dropped event.
    await ad.drainAlertDismissals(client)
    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item!.state).toBe('resolved')
  })

  it('cascade-deletes the fix task when purging an origin, both rows gone and both task.dropped events emitted', async () => {
    // Acceptance criterion (ADR-0049): purging an origin with a recovery arc
    // must delete BOTH the origin and its fix task. Neither row survives. Both
    // task.dropped events are emitted before the DELETEs so the Invalidator can
    // clear their Action-queue rows without a 500.
    const { q, actionQueue, ad, pt } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed a failed origin task.
    const origin = await q.enqueueTask('origin with recovery', undefined, { skipTriage: true })
    await q.updateTask(origin.id, { status: 'failed', error: 'test failure' })

    // Directly insert a fix task pointing at the origin.
    const fixId = 'mars-casc-fix01'
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, kind, origin_id, priority, created_at, updated_at, retry_count)
            VALUES (?, ?, 'queued', ?, 'fix', ?, 0, datetime('now'), datetime('now'), 0)`,
      args: [fixId, 'recovery for origin', origin.id, origin.id],
    })

    // Raise an Action-queue item for both origin and fix task so we can confirm
    // drainAlertDismissals clears both.
    const originItemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: `Task ${origin.id} failed`,
      body: 'stuck',
      payload: {},
      context: { task_id: origin.id },
      raisedBy: 'orchestrator:test',
      signature: `sig-origin-${origin.id}`,
      originTaskId: origin.id,
    })
    const fixItemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: `Task ${fixId} failed`,
      body: 'fix stuck',
      payload: {},
      context: { task_id: fixId },
      raisedBy: 'orchestrator:test',
      signature: `sig-fix-${fixId}`,
      originTaskId: fixId,
    })

    // Register subscriber AFTER seeding so pre-purge events are behind the cursor.
    await ad.ensureAlertDismisser(client)

    // Purge the origin with force=true (no branch exists, git branch -D fails silently).
    const result = await pt.corePurgeTask(origin.id, true, 'main', repo)

    // Both rows must be gone.
    expect(await (q as unknown as { getTask: (id: string) => Promise<unknown> }).getTask(origin.id)).toBeNull()
    expect(await (q as unknown as { getTask: (id: string) => Promise<unknown> }).getTask(fixId)).toBeNull()

    // cascadedFixTaskIds must include the fix task.
    expect((result as unknown as { cascadedFixTaskIds: string[] }).cascadedFixTaskIds).toContain(fixId)

    // Both task.dropped events must exist in the events table.
    const droppedEvts = await client.execute({
      sql: `SELECT json_extract(payload, '$.taskId') AS tid
            FROM events WHERE type = 'task.dropped'
            AND json_extract(payload, '$.taskId') IN (?, ?)`,
      args: [origin.id, fixId],
    })
    const droppedIds = droppedEvts.rows.map((r) => (r as unknown as { tid: string }).tid)
    expect(droppedIds).toContain(origin.id)
    expect(droppedIds).toContain(fixId)

    // After draining, both Action-queue items must be resolved.
    await ad.drainAlertDismissals(client)
    const originItem = await actionQueue.getActionQueueItem(originItemId)
    const fixItem = await actionQueue.getActionQueueItem(fixItemId)
    expect(originItem!.state).toBe('resolved')
    expect(fixItem!.state).toBe('resolved')
  })
})
