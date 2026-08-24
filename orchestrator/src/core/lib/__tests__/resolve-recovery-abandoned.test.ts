/**
 * resolveAllRowsForTask and dismissAlertsOnStatusChange — recovery-abandoned coverage.
 *
 * Regression test for the 2026-08-24 incident where three `recovery-abandoned`
 * rows outlived their settled arcs (origins reached done/dropped) and had to
 * be closed manually with `mars action-queue resolve`.
 *
 * Root cause: `resolveAllRowsForTask` and `dismissAlertsOnStatusChange` had no
 * predicate arm for `recovery-abandoned` rows whose `origin_task_id` is NULL
 * (legacy rows raised before the column was populated). Such rows rely on the
 * `recovery-abandoned:<originId>` signature to identify the origin but neither
 * closing function matched them on the live path — they only got swept at
 * boot by `reconcileTerminalTasks` leg (d), which was not always in time.
 *
 * Fix: added a fourth arm to `resolveAllRowsForTask` and a third arm to
 * `dismissAlertsOnStatusChange` matching
 *   `kind = 'recovery-abandoned' AND signature = 'recovery-abandoned:' || :taskId
 *    AND origin_task_id IS NULL`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
}

interface ActionQueueModule {
  initActionQueue: typeof import('../action-queue').initActionQueue
  raiseActionQueueItem: typeof import('../action-queue').raiseActionQueueItem
  getActionQueueItem: typeof import('../action-queue').getActionQueueItem
  resolveAllRowsForTask: typeof import('../action-queue').resolveAllRowsForTask
  dismissAlertsOnStatusChange: typeof import('../action-queue').dismissAlertsOnStatusChange
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-resolve-recovery-abandoned-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../action-queue')) as unknown as ActionQueueModule
  await actionQueue.initActionQueue()
  return { q, actionQueue }
}

describe('resolveAllRowsForTask — recovery-abandoned rows', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('closes a recovery-abandoned row with origin_task_id set when the origin resolves', async () => {
    const { actionQueue } = await loadModules(repo)
    const originId = 'mars-origin-001'

    // Current-style row: originTaskId populates origin_task_id column.
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'recovery-abandoned',
      category: 'orchestrator',
      priority: 'high',
      title: 'Recovery task dropped',
      body: `Run mars continue ${originId}`,
      payload: { fixTaskId: 'fix-aaa', originTaskId: originId },
      context: {},
      raisedBy: 'test',
      signature: `recovery-abandoned:${originId}`,
      originTaskId: originId,
    })

    await actionQueue.resolveAllRowsForTask(originId)

    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.status).toBe('resolved')
  })

  it('closes a legacy recovery-abandoned row (NULL origin_task_id) when the origin resolves', async () => {
    const { actionQueue } = await loadModules(repo)
    const originId = 'mars-origin-002'

    // Legacy-style row: originTaskId NOT passed → origin_task_id is NULL in DB.
    // The row is only identifiable by its signature.
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'recovery-abandoned',
      category: 'orchestrator',
      priority: 'high',
      title: 'Recovery task dropped',
      body: `Run mars continue ${originId}`,
      payload: { fixTaskId: 'fix-bbb', originTaskId: originId },
      context: {},
      raisedBy: 'test',
      signature: `recovery-abandoned:${originId}`,
      // intentionally omitting originTaskId — simulates legacy NULL origin_task_id
    })

    await actionQueue.resolveAllRowsForTask(originId)

    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.status).toBe('resolved')
  })

  it('does NOT close a recovery-abandoned row for a different origin', async () => {
    const { actionQueue } = await loadModules(repo)
    const originId = 'mars-origin-003'
    const otherOriginId = 'mars-origin-004'

    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'recovery-abandoned',
      category: 'orchestrator',
      priority: 'high',
      title: 'Recovery task dropped',
      body: `Run mars continue ${originId}`,
      payload: { fixTaskId: 'fix-ccc', originTaskId: originId },
      context: {},
      raisedBy: 'test',
      signature: `recovery-abandoned:${originId}`,
    })

    // Resolving a DIFFERENT origin must not touch this row.
    await actionQueue.resolveAllRowsForTask(otherOriginId)

    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.status).toBe('open')
  })
})

describe('dismissAlertsOnStatusChange — recovery-abandoned rows', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('closes a legacy recovery-abandoned row (NULL origin_task_id) on status-change', async () => {
    const { actionQueue } = await loadModules(repo)
    const originId = 'mars-origin-005'

    // Legacy-style row: no originTaskId → origin_task_id NULL, fingerprint not set.
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'recovery-abandoned',
      category: 'orchestrator',
      priority: 'high',
      title: 'Recovery task dropped',
      body: `Run mars continue ${originId}`,
      payload: { fixTaskId: 'fix-ddd', originTaskId: originId },
      context: {},
      raisedBy: 'test',
      signature: `recovery-abandoned:${originId}`,
    })

    await actionQueue.dismissAlertsOnStatusChange(originId, 'done')

    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.status).toBe('resolved')
  })

  it('does NOT close a legacy recovery-abandoned row for a different origin on status-change', async () => {
    const { actionQueue } = await loadModules(repo)
    const originId = 'mars-origin-006'
    const otherOriginId = 'mars-origin-007'

    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'recovery-abandoned',
      category: 'orchestrator',
      priority: 'high',
      title: 'Recovery task dropped',
      body: `Run mars continue ${originId}`,
      payload: { fixTaskId: 'fix-eee', originTaskId: originId },
      context: {},
      raisedBy: 'test',
      signature: `recovery-abandoned:${originId}`,
    })

    await actionQueue.dismissAlertsOnStatusChange(otherOriginId, 'done')

    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.status).toBe('open')
  })
})
