/**
 * Regression guard for the "exactly one park" invariant that the HITL
 * park-path unification (PRD ae17340a-modular-core-program-make-every-mars-mod,
 * slice 27) must preserve.
 *
 * Today a task parks in `awaiting-human` through one of two call sites, both
 * of which ultimately call {@link raiseActionQueueItem} with
 * `kind: 'awaiting-human'` and `originTaskId: taskId`:
 *
 *   - the sentinel-throw fallback in `tools/human/await-human.ts`
 *     (`raisedBy: 'primitive:await-human'`), used when no `onManualPark`
 *     hook is registered (scaffolded workflows, tests);
 *   - the promise-based `onManualPark` hook the daemon injects in
 *     `core/daemon/server.ts` (`raisedBy: 'primitive:manual-step'`), the
 *     preferred path when a real daemon is running.
 *
 * The two paths build the action-queue row from slightly different title/body
 * strings but agree on `kind`, `originTaskId`, and the `LeaseParkPayload`
 * shape. This test exercises `raiseActionQueueItem` directly with both
 * call shapes (rather than driving the full workflow engine, which is out of
 * scope for this slice) and pins the invariant acceptance criterion #2
 * requires regardless of which path — or, once unified, the single
 * surviving path — raises the park: exactly one open row and exactly one
 * durable `action-queue.raised` event per parked task, no matter how many
 * times the park is re-raised (re-dispatch, daemon restart racing a stale
 * in-flight park, etc).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { RaiseActionQueueItem } from '../action-queue'

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('../action-queue').raiseActionQueueItem
  listActionQueueItems: typeof import('../action-queue').listActionQueueItems
}

interface QueueModule {
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-unified-park-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ actionQueue: ActionQueueModule; queue: QueueModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const actionQueue = (await import('../action-queue')) as unknown as ActionQueueModule
  const queue = (await import('../../queue')) as unknown as QueueModule
  await queue.migrateQueueSchema()
  return { actionQueue, queue }
}

const getRaisedParkEvents = async (
  queue: QueueModule,
): Promise<Array<Record<string, unknown>>> => {
  const client = queue.resolveQueueClient()
  const result = await client.execute({
    sql: `SELECT payload FROM events WHERE type = 'action-queue.raised' ORDER BY id`,
    args: [],
  })
  return (result.rows as unknown as Array<{ payload: string }>)
    .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
    .filter((payload) => payload.kind === 'awaiting-human')
}

const now = '2026-01-01T00:00:00.000Z'

/** Mirrors `tools/human/await-human.ts`'s sentinel-throw fallback verbatim. */
const sentinelFallbackPark = (
  taskId: string,
  stepName: string,
): RaiseActionQueueItem<'awaiting-human'> => ({
  kind: 'awaiting-human',
  category: 'daemon',
  priority: 'normal',
  title: `Task ${taskId} parked at step '${stepName}' — awaiting human`,
  body: `Task ${taskId} is parked in its worktree at manual step '${stepName}'.`,
  payload: {
    situation: 'lease-park',
    taskId,
    leaseOwner: 'workflow:await-human',
    leasedAt: now,
    leaseNote: null,
    stepName,
  },
  context: { taskId },
  raisedBy: 'primitive:await-human',
  signature: taskId,
  originTaskId: taskId,
  occurrence: { leaseOwner: 'workflow:await-human', leasedAt: now, parkedAt: now },
})

/** Mirrors `core/daemon/server.ts`'s promise-based `onManualPark` hook verbatim. */
const promiseBasedPark = (
  taskId: string,
  stepName: string,
): RaiseActionQueueItem<'awaiting-human'> => ({
  kind: 'awaiting-human',
  category: 'daemon',
  priority: 'normal',
  title: `Task ${taskId} parked at step '${stepName}' — awaiting human`,
  body: `Task ${taskId} is parked at manual step '${stepName}'. Lease: workflow:await-human. Run \`mars step done ${taskId}\` to continue.`,
  payload: {
    situation: 'lease-park',
    taskId,
    leaseOwner: 'workflow:await-human',
    leasedAt: now,
    leaseNote: null,
    stepName,
  },
  context: { taskId },
  raisedBy: 'primitive:manual-step',
  signature: taskId,
  originTaskId: taskId,
  occurrence: { leaseOwner: 'workflow:await-human', leasedAt: now, parkedAt: now },
})

describe('unified park invariant — exactly one row, exactly one durable event', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('the sentinel-path and promise-path shapes fold onto the SAME open row', async () => {
    const { actionQueue } = await loadModules(repo)
    const taskId = 'mars-unified-park-1'

    const idFromSentinelPath = await actionQueue.raiseActionQueueItem(
      sentinelFallbackPark(taskId, 'await-human'),
    )
    const idFromPromisePath = await actionQueue.raiseActionQueueItem(
      promiseBasedPark(taskId, 'await-human'),
    )

    expect(idFromPromisePath).toBe(idFromSentinelPath)

    const open = await actionQueue.listActionQueueItems('open')
    const parkRows = open.filter((row) => row.id === idFromSentinelPath)
    expect(parkRows).toHaveLength(1)
    expect(parkRows[0].seenCount).toBe(2)
  })

  it('only the FIRST raise (whichever path) emits a durable action-queue.raised event', async () => {
    const { actionQueue, queue } = await loadModules(repo)
    const taskId = 'mars-unified-park-2'

    await actionQueue.raiseActionQueueItem(sentinelFallbackPark(taskId, 'await-human'))
    await actionQueue.raiseActionQueueItem(promiseBasedPark(taskId, 'await-human'))
    // A daemon restart racing a stale in-flight park re-raises a THIRD time —
    // still must not produce a second durable event for this task.
    await actionQueue.raiseActionQueueItem(sentinelFallbackPark(taskId, 'await-human'))

    const parkEvents = await getRaisedParkEvents(queue)
    expect(parkEvents).toHaveLength(1)
  })

  it('parking a DIFFERENT task produces its own independent row and event', async () => {
    const { actionQueue, queue } = await loadModules(repo)

    const idA = await actionQueue.raiseActionQueueItem(sentinelFallbackPark('mars-park-a', 'await-human'))
    const idB = await actionQueue.raiseActionQueueItem(promiseBasedPark('mars-park-b', 'await-human'))

    expect(idA).not.toBe(idB)

    const open = await actionQueue.listActionQueueItems('open')
    const parkRows = open.filter((row) => row.id === idA || row.id === idB)
    expect(parkRows).toHaveLength(2)

    const parkEvents = await getRaisedParkEvents(queue)
    expect(parkEvents).toHaveLength(2)
  })
})
