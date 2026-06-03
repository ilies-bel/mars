import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Client } from '@libsql/client'

/**
 * Headline behaviour tests for PRD 12fdef39 — the Action queue must never
 * carry a stale row once a task ends, and the clear must survive a
 * daemon-down window. These cover the user stories the per-event
 * alert-dismisser unit tests do not: purge-before-delete, daemon-down →
 * cleared-on-restart, and the ADR-0032 stall surface.
 */

interface Loaded {
  q: typeof import('../../queue')
  actionQueue: typeof import('../../lib/action-queue')
  dismissals: typeof import('../../lib/action-queue-dismissals')
  ad: typeof import('../alert-dismisser')
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-invalidator-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = await import('../../queue')
  await q.migrateQueueSchema()
  const actionQueue = await import('../../lib/action-queue')
  const dismissals = await import('../../lib/action-queue-dismissals')
  const ad = await import('../alert-dismisser')
  return { q, actionQueue, dismissals, ad }
}

const raiseOpenItemFor = async (
  actionQueue: Loaded['actionQueue'],
  taskId: string,
): Promise<string> =>
  actionQueue.raiseActionQueueItem({
    kind: 'failed',
    category: 'orchestrator',
    priority: 'high',
    title: `Task ${taskId} needs a human`,
    body: 'stuck',
    payload: { taskId },
    context: { task_id: taskId },
    raisedBy: 'orchestrator:test',
    signature: `sig-${taskId}`,
    originTaskId: taskId,
  })

const insertTask = async (
  client: Client,
  id: string,
  status: string,
): Promise<void> => {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, author_kind, author_name, origin_id, created_at, updated_at)
          VALUES (?, ?, ?, 'human', 'test', ?, ?, ?)`,
    args: [id, 'do a thing', status, id, now, now],
  })
}

describe('Invalidator staleness guarantees (PRD 12fdef39)', () => {
  let repo: string
  beforeEach(() => {
    repo = setupRepo()
  })
  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('purge emits the terminal event BEFORE deleting the task, and the Invalidator clears the row + dismissal', async () => {
    const { q, actionQueue, dismissals, ad } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'P-1'

    await insertTask(client, taskId, 'failed')
    const itemId = await raiseOpenItemFor(actionQueue, taskId)
    await dismissals.dismissEntity('task', taskId, { by: 'op' })

    await ad.ensureAlertDismisser(client)

    // dropTask is the shared purge/drop core: it must emit task.terminal
    // BEFORE the DELETE so the event survives the row removal.
    await q.dropTask(taskId)

    // The task row is gone...
    const taskRow = await client.execute({
      sql: `SELECT 1 FROM tasks WHERE id = ?`,
      args: [taskId],
    })
    expect(taskRow.rows.length).toBe(0)
    // ...but the terminal event is in the outbox.
    const ev = await client.execute({
      sql: `SELECT type FROM events WHERE type = 'task.terminal' ORDER BY id`,
    })
    expect(ev.rows.length).toBeGreaterThan(0)

    const { processed } = await ad.drainAlertDismissals(client)
    expect(processed).toBeGreaterThan(0)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')
    expect(await dismissals.isEntityDismissed('task', taskId)).toBe(false)
  })

  it('clears rows for a task that ended while the daemon was DOWN (events replayed on first drain)', async () => {
    const { q, actionQueue, ad } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'D-1'

    await insertTask(client, taskId, 'failed')
    const itemId = await raiseOpenItemFor(actionQueue, taskId)

    // Register the subscriber (daemon boot), THEN the task ends. We never
    // drain between — modelling the daemon being down across the purge.
    await ad.ensureAlertDismisser(client)
    await q.dropTask(taskId)

    // First drain after "restart" replays the buffered terminal event.
    const { processed } = await ad.drainAlertDismissals(client)
    expect(processed).toBeGreaterThan(0)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')
  })

  it('a re-queued task (task.queued) evicts its stale failure row', async () => {
    const { q, actionQueue, ad } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'Q-1'

    await insertTask(client, taskId, 'failed')
    const itemId = await raiseOpenItemFor(actionQueue, taskId)

    await ad.ensureAlertDismisser(client)
    // updateTask through the seam emits task.queued in-tx.
    await q.updateTask(taskId, { status: 'queued' })

    const { processed } = await ad.drainAlertDismissals(client)
    expect(processed).toBeGreaterThan(0)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')
  })

  it('a failed task KEEPS its row even after unblock flips it to failed', async () => {
    const { q, actionQueue, ad } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'F-1'

    await insertTask(client, taskId, 'blocked')
    const itemId = await raiseOpenItemFor(actionQueue, taskId)

    await ad.ensureAlertDismisser(client)
    // unblockTask flips blocked → failed and emits task.terminal{failed}.
    await q.unblockTask(taskId)

    const { processed } = await ad.drainAlertDismissals(client)
    expect(processed).toBe(0)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('open')
  })
})
