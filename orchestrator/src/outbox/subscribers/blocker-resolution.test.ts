import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  migrateQueueSchema: typeof import('../../core/queue').migrateQueueSchema
  enqueueTask: typeof import('../../core/queue').enqueueTask
  addBlockers: typeof import('../../core/queue').addBlockers
  getTask: typeof import('../../core/queue').getTask
  resolveQueueClient: typeof import('../../core/queue').resolveQueueClient
}

interface BlockerResolutionSubscriberModule {
  BLOCKER_RESOLUTION_SUBSCRIBER: typeof import('./blocker-resolution').BLOCKER_RESOLUTION_SUBSCRIBER
  ensureBlockerResolutionSubscriber: typeof import('./blocker-resolution').ensureBlockerResolutionSubscriber
  drainBlockerResolution: typeof import('./blocker-resolution').drainBlockerResolution
}

interface PublisherModule {
  publishWithRetry: typeof import('../../bus/publisher').publishWithRetry
}

interface SubscribersModule {
  getCursor: typeof import('../../bus/subscribers').getCursor
}

interface Loaded {
  q: QueueModule
  sub: BlockerResolutionSubscriberModule
  pub: PublisherModule
  subs: SubscribersModule
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-blocker-res-sub-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../core/queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const sub = (await import('./blocker-resolution')) as unknown as BlockerResolutionSubscriberModule
  const pub = (await import('../../bus/publisher')) as unknown as PublisherModule
  const subs = (await import('../../bus/subscribers')) as unknown as SubscribersModule
  return { q, sub, pub, subs }
}

/**
 * Set a task's status to 'blocked' and add a blocker edge.
 * Uses raw SQL to bypass any auto-promote logic so the subscriber is
 * the only thing that can flip it back to 'queued'.
 */
const blockTask = async (
  q: QueueModule,
  taskId: string,
  blockerTaskId: string,
  retryCount = 0,
): Promise<void> => {
  await q.addBlockers(taskId, [blockerTaskId])
  await q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET status = 'blocked', retry_count = ? WHERE id = ?`,
    args: [retryCount, taskId],
  })
}

describe('blocker-resolution outbox subscriber', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('unblocks a blocked dependent when task.terminal { reason: done } event is drained', async () => {
    // AC1: a task whose last blocker reaches done flips to queued without any
    // boot-time scan — the subscriber drives the transition.
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, sub, pub } = await loadModules(repo)
    const dep = await q.enqueueTask('dependent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    await blockTask(q, dep.id, blocker.id)
    // Bypass updateTask auto-promote so only the subscriber can unblock.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [blocker.id],
    })

    await sub.ensureBlockerResolutionSubscriber(q.resolveQueueClient())
    await pub.publishWithRetry(q.resolveQueueClient(), 'task.terminal', {
      taskId: blocker.id,
      reason: 'done',
    })
    const { processed } = await sub.drainBlockerResolution(q.resolveQueueClient())

    expect(processed).toBeGreaterThan(0)
    expect((await q.getTask(dep.id))?.status).toBe('queued')
  })

  it('replays missed task.terminal events after a restart (cursor-based recovery)', async () => {
    // AC2: killing the daemon between a blocker reaching done and dependents
    // unblocking, then restarting, still unblocks the dependents. Modelled
    // here by publishing the event and registering the subscriber BEFORE
    // draining, then draining — the cursor picks up the un-acked event.
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, sub, pub } = await loadModules(repo)
    const dep = await q.enqueueTask('dependent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    await blockTask(q, dep.id, blocker.id)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [blocker.id],
    })

    // Register subscriber so cursor = current head (before the event).
    await sub.ensureBlockerResolutionSubscriber(q.resolveQueueClient())

    // Publish event (simulates blocker reaching done with event in outbox).
    await pub.publishWithRetry(q.resolveQueueClient(), 'task.terminal', {
      taskId: blocker.id,
      reason: 'done',
    })

    // Simulate daemon crash: do NOT drain now.
    // Re-register is a no-op — cursor is preserved across "restarts".
    await sub.ensureBlockerResolutionSubscriber(q.resolveQueueClient())

    // Drain on "restart" — event is replayed from the cursor position.
    await sub.drainBlockerResolution(q.resolveQueueClient())

    expect((await q.getTask(dep.id))?.status).toBe('queued')
  })

  it('unblocks origin dependents when recovery task success causes origin task.terminal event', async () => {
    // AC3: a recovery task succeeding still unblocks the origin's dependents.
    // The subscriber reacts to origin's task.terminal event (published by
    // markOriginDoneFromRecovery) and calls onBlockerTaskCompleted(originId).
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, sub, pub } = await loadModules(repo)
    const origin = await q.enqueueTask('origin', undefined, { skipTriage: true })
    const sibling = await q.enqueueTask('sibling', undefined, { skipTriage: true })
    // sibling is blocked waiting on origin
    await blockTask(q, sibling.id, origin.id)
    // origin is done (flipped by markOriginDoneFromRecovery)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [origin.id],
    })

    await sub.ensureBlockerResolutionSubscriber(q.resolveQueueClient())
    // Publish origin's task.terminal event (as markOriginDoneFromRecovery does)
    await pub.publishWithRetry(q.resolveQueueClient(), 'task.terminal', {
      taskId: origin.id,
      reason: 'done',
    })
    await sub.drainBlockerResolution(q.resolveQueueClient())

    expect((await q.getTask(sibling.id))?.status).toBe('queued')
  })

  it('ignores task.terminal events with reason other than done', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, sub, pub } = await loadModules(repo)
    const dep = await q.enqueueTask('dependent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    await blockTask(q, dep.id, blocker.id)

    await sub.ensureBlockerResolutionSubscriber(q.resolveQueueClient())
    await pub.publishWithRetry(q.resolveQueueClient(), 'task.terminal', {
      taskId: blocker.id,
      reason: 'failed',
    })
    const { processed } = await sub.drainBlockerResolution(q.resolveQueueClient())

    expect(processed).toBe(0)
    expect((await q.getTask(dep.id))?.status).toBe('blocked')
  })

  it('is idempotent — draining twice on the same event is a no-op the second time', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, sub, pub } = await loadModules(repo)
    const dep = await q.enqueueTask('dependent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    await blockTask(q, dep.id, blocker.id)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [blocker.id],
    })

    await sub.ensureBlockerResolutionSubscriber(q.resolveQueueClient())
    await pub.publishWithRetry(q.resolveQueueClient(), 'task.terminal', {
      taskId: blocker.id,
      reason: 'done',
    })

    const first = await sub.drainBlockerResolution(q.resolveQueueClient())
    const second = await sub.drainBlockerResolution(q.resolveQueueClient())

    expect(first.processed).toBeGreaterThan(0)
    expect(second.processed).toBe(0) // cursor already advanced; no pending events
    expect((await q.getTask(dep.id))?.status).toBe('queued')
  })

  it('does not unblock when one of multiple blockers is still pending', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, sub, pub } = await loadModules(repo)
    const dep = await q.enqueueTask('dep', undefined, { skipTriage: true })
    const a = await q.enqueueTask('a', undefined, { skipTriage: true })
    const b = await q.enqueueTask('b', undefined, { skipTriage: true })
    await q.addBlockers(dep.id, [a.id, b.id])
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked', retry_count = 0 WHERE id = ?`,
      args: [dep.id],
    })
    // Only a is done; b is still pending.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [a.id],
    })

    await sub.ensureBlockerResolutionSubscriber(q.resolveQueueClient())
    await pub.publishWithRetry(q.resolveQueueClient(), 'task.terminal', {
      taskId: a.id,
      reason: 'done',
    })
    await sub.drainBlockerResolution(q.resolveQueueClient())

    // dep still has blocker b pending — must remain blocked
    expect((await q.getTask(dep.id))?.status).toBe('blocked')
  })
})
