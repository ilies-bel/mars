/**
 * Regression test: dropping a failed task must close its open action-queue
 * rows synchronously (inline), without waiting for the Invalidator event drain.
 *
 * Bug: mars drop of a failed task left its failed-task action-queue row open;
 * the row only closed after a manual 'mars action-queue reconcile'. This
 * violates ADR-0048 (pure-projection contract) and ADR-0041 (durable-invalidator
 * model).
 *
 * Fix: Arc.drop() now calls resolveAllRowsForTask + supersedeActionQueueItemsForOrigin
 * before the atomic DELETE, mirroring the belt-and-suspenders closure in corePurgeTask.
 *
 * Acceptance criteria:
 *   (a) dropTask on a failed task with an open action-queue row resolves the row
 *       WITHOUT a separate drainAlertDismissals call (inline close).
 *   (b) dropTask on an origin task with a cascaded fix task closes BOTH
 *       action-queue rows inline (origin + fix task).
 *   (c) Existing purge auto-dismiss behaviour is unaffected (regression guard:
 *       calling corePurgeTask still resolves rows — purge tests stay green).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  dropTask: typeof import('../../queue').dropTask
}

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
  initActionQueue: typeof import('../../lib/action-queue').initActionQueue
}

interface Loaded {
  q: QueueModule
  actionQueue: ActionQueueModule
}

/** Create a minimal git repo with one commit on main so Arc operations work. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-drop-closes-aq-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  await actionQueue.initActionQueue()
  return { q, actionQueue }
}

describe('dropTask — inline action-queue row resolution (no event drain needed)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('(a) resolves the action-queue row for a failed task inline, without needing event drain', async () => {
    const { q, actionQueue } = await loadModules(repo)

    // Seed a failed task.
    const task = await q.enqueueTask('drop-closes-aq test', undefined, { skipTriage: true })
    await q.updateTask(task.id, { status: 'failed', error: 'test failure' })

    // Raise an open action-queue row for the task.
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: `Task ${task.id} failed`,
      body: 'stuck',
      payload: {},
      context: { task_id: task.id },
      raisedBy: 'orchestrator:test',
      signature: `sig-drop-${task.id}`,
      originTaskId: task.id,
    })

    // Confirm row is open before the drop.
    const before = await actionQueue.getActionQueueItem(itemId)
    expect(before!.state).toBe('open')

    // Drop the task. Arc.drop() must close the action-queue row inline,
    // WITHOUT any separate drainAlertDismissals call.
    await q.dropTask(task.id)

    // The row must be resolved immediately — no event drain, no reconcile.
    const after = await actionQueue.getActionQueueItem(itemId)
    expect(after!.state).toBe('resolved')
  })

  it('(b) closes action-queue rows for both origin and cascaded fix task inline', async () => {
    const { q, actionQueue } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Seed a failed origin task.
    const origin = await q.enqueueTask('origin for drop cascade', undefined, { skipTriage: true })
    await q.updateTask(origin.id, { status: 'failed', error: 'test failure' })

    // Directly insert a fix task pointing at the origin (mirrors production arc structure).
    const fixId = 'mars-drop-fix-001'
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, kind, origin_id, priority, created_at, updated_at, recovery_spawned_count)
            VALUES (?, ?, 'failed', ?, 'fix', ?, 0, datetime('now'), datetime('now'), 0)`,
      args: [fixId, 'recovery for origin', origin.id, origin.id],
    })

    // Raise open action-queue rows for BOTH the origin and the fix task.
    const originItemId = await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: `Task ${origin.id} failed`,
      body: 'origin stuck',
      payload: {},
      context: { task_id: origin.id },
      raisedBy: 'orchestrator:test',
      signature: `sig-drop-origin-${origin.id}`,
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
      signature: `sig-drop-fix-${fixId}`,
      originTaskId: fixId,
    })

    // Confirm both rows are open before the drop.
    expect((await actionQueue.getActionQueueItem(originItemId))!.state).toBe('open')
    expect((await actionQueue.getActionQueueItem(fixItemId))!.state).toBe('open')

    // Drop the origin. Arc.drop() cascades to delete the fix task and must
    // close BOTH action-queue rows inline — no drainAlertDismissals call.
    const result = await q.dropTask(origin.id)

    // Both rows must be resolved immediately.
    const originItem = await actionQueue.getActionQueueItem(originItemId)
    const fixItem = await actionQueue.getActionQueueItem(fixItemId)
    expect(originItem!.state).toBe('resolved')
    expect(fixItem!.state).toBe('resolved')

    // The cascadedFixTaskIds must include the fix task (sanity check).
    expect((result as unknown as { cascadedFixTaskIds: string[] }).cascadedFixTaskIds).toContain(fixId)
  })
})
