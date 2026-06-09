/**
 * ADR-0054 conformance tests for the investigate-stale-worktree action.
 *
 * The alert is a level-triggered projection of entity state. These tests
 * verify that:
 *   1. Attaching an investigation annotation (patchOpenActionQueuePayload)
 *      lands on the LIVE open row and leaves it open.
 *   2. patchOpenActionQueuePayload is a no-op when the row is already
 *      resolved — the investigation has no target, not the wrong target.
 *   3. The alert clears ONLY when the entity mutates (task reaches terminal),
 *      NOT when the investigation runs.
 *
 * These tests exercise patchOpenActionQueuePayload directly — the same
 * function the fixed investigateWorktree calls after the Haiku analysis.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  enqueueTask: typeof import('../../queue').enqueueTask
}

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
  patchOpenActionQueuePayload: typeof import('../../lib/action-queue').patchOpenActionQueuePayload
  resolveAllRowsForTask: typeof import('../../lib/action-queue').resolveAllRowsForTask
  dismissAlertsOnStatusChange: typeof import('../../lib/action-queue').dismissAlertsOnStatusChange
}

interface Loaded {
  q: QueueModule
  actionQueue: ActionQueueModule
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-investigate-adr0054-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<Loaded> => {
  const { vi } = await import('vitest')
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  return { q, actionQueue }
}

/** Raise a single open, origin-keyed stale-worktree alert for `taskId`. */
const raiseStaleWorktreeAlert = async (
  actionQueue: ActionQueueModule,
  taskId: string,
): Promise<string> =>
  actionQueue.raiseActionQueueItem({
    kind: 'stale-worktree',
    category: 'daemon',
    priority: 'normal',
    title: `Stale worktree: task ${taskId}`,
    body: `Task ${taskId} has a stale worktree.`,
    payload: { ageHours: 48, status: 'running' },
    context: { taskId },
    raisedBy: 'daemon:stale-worktree-sweep',
    signature: taskId,
    originTaskId: taskId,
  })

describe('ADR-0054: investigate patches the LIVE open alert, not a resolved row', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(async () => {
    const { vi } = await import('vitest')
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
    vi.resetModules()
  })

  it('investigation annotation lands on the open row — row stays open', async () => {
    // This is what the fixed investigateWorktree does after Haiku finishes.
    const { q, actionQueue } = await loadModules(repo)
    const task = await q.enqueueTask('stale task', undefined, { skipTriage: true })
    const taskId = task.id
    const itemId = await raiseStaleWorktreeAlert(actionQueue, taskId)

    // Simulate the investigation completing and patching the open row.
    const patched = await actionQueue.patchOpenActionQueuePayload(taskId, {
      investigation: { text: 'The task was adding a CLI flag.', investigatedAt: '2026-01-01T00:00:00.000Z' },
    })

    // The patch was applied to the open row.
    expect(patched).toBe(itemId)

    // The row is STILL OPEN — investigation is an annotation, not a resolution.
    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item).not.toBeNull()
    expect(item!.state).toBe('open')
    expect(item!.payload.investigation).toEqual({
      text: 'The task was adding a CLI flag.',
      investigatedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('patchOpenActionQueuePayload is a no-op when the row is already resolved — does NOT write to a resolved row', async () => {
    // If the worktree was pruned while Haiku was running, the row is resolved.
    // patchOpenActionQueuePayload must be a no-op — it should NOT stamp
    // investigation text onto the resolved row.
    const { q, actionQueue } = await loadModules(repo)
    const task = await q.enqueueTask('stale resolved', undefined, { skipTriage: true })
    const taskId = task.id
    const itemId = await raiseStaleWorktreeAlert(actionQueue, taskId)

    // Resolve the row (entity mutated — worktree pruned / task went terminal).
    await actionQueue.resolveAllRowsForTask(taskId)
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')

    // Haiku arrives late and tries to patch — must be a no-op.
    const patched = await actionQueue.patchOpenActionQueuePayload(taskId, {
      investigation: { text: 'late arrival', investigatedAt: '2026-01-01T00:00:00.000Z' },
    })

    expect(patched).toBeNull()

    // The resolved row must NOT have the investigation payload.
    const item = await actionQueue.getActionQueueItem(itemId)
    expect(item!.state).toBe('resolved')
    expect(item!.payload.investigation).toBeUndefined()
  })

  it('alert clears ONLY when entity mutates (dismissAlertsOnStatusChange), not when investigation annotation is added', async () => {
    // Sequence: raise alert → annotate with investigation → alert stays open
    //           → entity mutates → alert clears.
    const { q, actionQueue } = await loadModules(repo)
    const task = await q.enqueueTask('stale lifecycle', undefined, { skipTriage: true })
    const taskId = task.id
    const itemId = await raiseStaleWorktreeAlert(actionQueue, taskId)

    // Investigation annotation added — alert must stay open.
    await actionQueue.patchOpenActionQueuePayload(taskId, {
      investigation: { text: 'investigating…', investigatedAt: '2026-01-01T00:00:00.000Z' },
    })
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('open')

    // Entity mutates (task reached terminal state) — NOW the alert clears.
    await actionQueue.dismissAlertsOnStatusChange(taskId, 'done')
    expect((await actionQueue.getActionQueueItem(itemId))!.state).toBe('resolved')
  })

  it('stale-worktree sweep re-detecting the worktree bumps the existing OPEN row (investigation not orphaned)', async () => {
    // With the level-triggered model the first row stays open through
    // investigation. A subsequent sweep detects the same stale worktree and
    // bumps the existing open row's seen_count — it does NOT create a
    // separate row (the investigation annotation remains visible).
    const { q, actionQueue } = await loadModules(repo)
    const task = await q.enqueueTask('stale revisit', undefined, { skipTriage: true })
    const taskId = task.id
    const firstItemId = await raiseStaleWorktreeAlert(actionQueue, taskId)

    // Annotate the open row with investigation text.
    await actionQueue.patchOpenActionQueuePayload(taskId, {
      investigation: { text: 'still investigating', investigatedAt: '2026-01-01T00:00:00.000Z' },
    })

    // Sweep re-detects: raiseActionQueueItem bumps the existing open row.
    const secondRaiseId = await raiseStaleWorktreeAlert(actionQueue, taskId)

    // The same open row was bumped (same id), not a new one.
    expect(secondRaiseId).toBe(firstItemId)

    // The investigation annotation is still present on the live row.
    const item = await actionQueue.getActionQueueItem(firstItemId)
    expect(item!.state).toBe('open')
    expect(item!.payload.investigation).toBeDefined()
  })
})
