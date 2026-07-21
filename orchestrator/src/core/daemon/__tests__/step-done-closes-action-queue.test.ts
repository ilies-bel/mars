/**
 * Regression test: `mars step done` must resolve (close) the open
 * `awaiting-human` action-queue row for the completed manual step.
 *
 * Bug: the row raised by `awaitHuman` / `parkForHuman` when a manual step
 * parked (with `signature: taskId`) was NOT superseded when the operator ran
 * `mars step done` and the task advanced. The row stayed `open`, pointing the
 * operator at a step that was already finished.
 *
 * Fix: `handleStepDone` (server.ts) now calls
 * `supersedeActionQueueItemsBySignature('awaiting-human', taskId, 'step-done',
 * 'daemon:step-done')` before resolving the in-process promise.
 *
 * This test exercises that mechanic directly against the real action-queue
 * storage so it covers the projection (what rows are open after the call) not
 * the implementation (which function was called).
 *
 * DB setup is done ONCE in `beforeAll` (PGlite file-backed init is ~5-10 s
 * on a cold machine; per-test setup would exceed vitest's 5 s default).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// Set timeout high enough for PGlite cold start.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

let repo: string
let q: typeof import('../../queue')
let actionQueue: typeof import('../../lib/action-queue')

beforeAll(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-step-done-aq-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })

  vi.resetModules()
  process.env.MARS_REPO = repo
  q = await import('../../queue')
  await q.migrateQueueSchema()
  actionQueue = await import('../../lib/action-queue')
  await actionQueue.initActionQueue()
})

afterAll(() => {
  delete process.env.MARS_REPO
  vi.resetModules()
  rmSync(repo, { recursive: true, force: true })
})

describe('step-done closes awaiting-human action-queue row', () => {
  it('supersedeActionQueueItemsBySignature("awaiting-human") closes the row for the parked task', async () => {
    // Seed: a task parked at a manual step.
    const task = await q.enqueueTask('manual step task', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'awaiting-human',
      leaseOwner: 'alice@laptop',
      leasedAt: new Date().toISOString(),
      currentStepName: 'code',
    })

    // Raise the awaiting-human row exactly as parkForHuman / awaitHuman do:
    // signature = taskId, kind = 'awaiting-human'.
    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'daemon',
      priority: 'normal',
      title: `Task ${task.id} parked at step 'code' — awaiting human`,
      body: `Task ${task.id} is parked at manual step 'code'.`,
      payload: { taskId: task.id, leaseOwner: 'alice@laptop', leasedAt: new Date().toISOString(), leaseNote: null },
      context: { taskId: task.id },
      raisedBy: 'primitive:manual-step',
      signature: task.id,
      originTaskId: task.id,
    })

    // Confirm the row is open before the step-done gesture.
    const before = await actionQueue.getActionQueueItem(itemId)
    expect(before?.state).toBe('open')

    // Simulate what handleStepDone now calls (the fix): supersede by signature.
    await actionQueue.supersedeActionQueueItemsBySignature(
      'awaiting-human',
      task.id,
      'step-done',
      'daemon:step-done',
    )

    // The row must be resolved — no orphaned open alert for a completed step.
    const after = await actionQueue.getActionQueueItem(itemId)
    expect(after?.state, 'awaiting-human row must be resolved after step-done').toBe('resolved')
  })

  it('is idempotent: calling supersede twice does not fail or re-open the row', async () => {
    const task = await q.enqueueTask('idempotent step-done task', undefined, { skipTriage: true })

    const itemId = await actionQueue.raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'daemon',
      priority: 'normal',
      title: `Task ${task.id} parked`,
      body: 'parked',
      payload: { taskId: task.id },
      context: { taskId: task.id },
      raisedBy: 'test',
      signature: task.id,
      originTaskId: task.id,
    })

    await actionQueue.supersedeActionQueueItemsBySignature('awaiting-human', task.id, 'step-done', 'daemon:step-done')
    // Second call must be a silent no-op.
    await actionQueue.supersedeActionQueueItemsBySignature('awaiting-human', task.id, 'step-done', 'daemon:step-done')

    const after = await actionQueue.getActionQueueItem(itemId)
    expect(after?.state).toBe('resolved')
  })

  it('does not close rows for a different task', async () => {
    const taskA = await q.enqueueTask('task A', undefined, { skipTriage: true })
    const taskB = await q.enqueueTask('task B', undefined, { skipTriage: true })

    const itemIdA = await actionQueue.raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'daemon',
      priority: 'normal',
      title: `Task ${taskA.id} parked`,
      body: 'parked A',
      payload: { taskId: taskA.id },
      context: { taskId: taskA.id },
      raisedBy: 'test',
      signature: taskA.id,
      originTaskId: taskA.id,
    })
    const itemIdB = await actionQueue.raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'daemon',
      priority: 'normal',
      title: `Task ${taskB.id} parked`,
      body: 'parked B',
      payload: { taskId: taskB.id },
      context: { taskId: taskB.id },
      raisedBy: 'test',
      signature: taskB.id,
      originTaskId: taskB.id,
    })

    // Only supersede task A.
    await actionQueue.supersedeActionQueueItemsBySignature('awaiting-human', taskA.id, 'step-done', 'daemon:step-done')

    const afterA = await actionQueue.getActionQueueItem(itemIdA)
    const afterB = await actionQueue.getActionQueueItem(itemIdB)

    expect(afterA?.state).toBe('resolved')
    expect(afterB?.state).toBe('open') // task B's row must remain open
  })
})
