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

// Regression: mars-984de140 — parked→committer-done must NOT produce false-done
//
// When a `main-commiter` recovery (fix task with recipe='main-commiter') reaches
// done, tasks parked behind it must be RE-QUEUED — never marked done via
// propagateRecoveryDone().  The false-done path was triggered when:
//   1. The parked task's retry budget was exhausted (high retry_count).
//   2. An OLDER done main-committer had fix_for_task_id pointing at the parked task
//      (pre-ADR-0040 "leaf-residue" edges).
// Arc.unblockByCompletion() would find that older committer via
// queryNonFailedOwnRecovery() and call propagateRecoveryDone(), falsely marking
// the parked task done without verify or merge ever running.
// ---------------------------------------------------------------------------
describe('blocker-resolution: main-committer done must re-queue parked tasks, not mark done (mars-984de140)', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-mc-false-done-test-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it(
    'parked task with exhausted budget and old done main-committer is re-queued, not marked done',
    async () => {
      // AC: a source task blocked on a new main-committer (C2), with its retry
      // budget exhausted AND an older DONE main-committer (C1) that has
      // fix_for_task_id = source.id, must become 'queued' (not 'done') when C2
      // completes.  This is the exact false-done sequence from 2026-07-03.
      process.env.MARS_FIX_RETRY_BUDGET = '3'
      const { q, sub, pub } = await loadModules(repo)
      const qc = q.resolveQueueClient()

      const MAIN_COMMITER_PAYLOAD = JSON.stringify({ recipe: 'main-commiter', dirtyMainHash: 'aa'.repeat(32), episodeHash: null, integrationBranch: 'main' })

      // Source task with high retry_count (budget = 3, so retry_count = 10 is exhausted)
      const src = await q.enqueueTask('implement-feature', undefined, { skipTriage: true })
      await qc.execute({ sql: `UPDATE tasks SET retry_count = 10 WHERE id = ?`, args: [src.id] })

      // Older done main-committer C1 with fix_for_task_id = src.id (pre-ADR-0040 residue)
      const c1Id = `fix-old1-${src.id.slice(0, 6)}`
      await qc.execute({
        sql: `INSERT INTO tasks (id, prompt, status, kind, author_kind, author_name, fix_for_task_id, retry_count, origin_id, priority, recovery_payload, created_at, updated_at)
              VALUES (?, 'clean main (old)', 'done', 'fix', 'agent', 'main-commiter-spawn', ?, 0, ?, 3, ?, datetime('now', '-5 minutes'), datetime('now', '-4 minutes'))`,
        args: [c1Id, src.id, src.id, MAIN_COMMITER_PAYLOAD],
      })

      // New main-committer C2: the one that just completed
      const c2Id = `fix-new-${src.id.slice(0, 6)}`
      await qc.execute({
        sql: `INSERT INTO tasks (id, prompt, status, kind, author_kind, author_name, fix_for_task_id, retry_count, origin_id, priority, recovery_payload, created_at, updated_at)
              VALUES (?, 'clean main (new)', 'done', 'fix', 'agent', 'main-commiter-spawn', ?, 0, ?, 3, ?, datetime('now', '-1 minute'), datetime('now'))`,
        args: [c2Id, src.id, src.id, MAIN_COMMITER_PAYLOAD],
      })

      // Park src behind C2 (raw SQL — ADR-0040 guard exemption for main-committers)
      await qc.execute({
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', datetime('now'))`,
        args: [src.id, c2Id],
      })
      await qc.execute({ sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`, args: [src.id] })

      await sub.ensureBlockerResolutionSubscriber(qc)
      // C2 reaches done — this is the event drainBlockerResolution will process
      await pub.publishWithRetry(qc, 'task.terminal', { taskId: c2Id, reason: 'done' })

      const { processed } = await sub.drainBlockerResolution(qc)

      expect(processed).toBeGreaterThan(0)
      // Critical: src must be re-queued so verify/merge can run — never 'done'
      const srcAfter = await q.getTask(src.id)
      expect(srcAfter?.status).toBe('queued')
      expect(srcAfter?.status).not.toBe('done')
    },
  )

  it(
    'non-main-committer own recovery that is done still triggers propagateRecoveryDone normally',
    async () => {
      // Regression guard: ensure we did NOT accidentally break the normal
      // recovery-done path.  A real (non-main-committer) fix task with
      // fix_for_task_id = origin should still cause origin → done.
      process.env.MARS_FIX_RETRY_BUDGET = '3'
      const { q, sub, pub } = await loadModules(repo)
      const qc = q.resolveQueueClient()

      // Origin + a "real" fix task (no main-commiter recipe)
      const origin = await q.enqueueTask('origin-task', undefined, { skipTriage: true })
      await qc.execute({ sql: `UPDATE tasks SET retry_count = 10 WHERE id = ?`, args: [origin.id] })

      // Real recovery task (kind='fix', no recovery_payload → not a main-committer)
      const fixId = `fix-real-${origin.id.slice(0, 6)}`
      await qc.execute({
        sql: `INSERT INTO tasks (id, prompt, status, kind, author_kind, author_name, fix_for_task_id, retry_count, origin_id, priority, recovery_payload, created_at, updated_at)
              VALUES (?, 'fix the code', 'done', 'fix', 'agent', 'recovery-spawn', ?, 0, ?, 3, NULL, datetime('now', '-1 minute'), datetime('now'))`,
        args: [fixId, origin.id, origin.id],
      })

      // A separate blocker that just completed — triggers unblockByCompletion
      const blocker = await q.enqueueTask('separate-blocker', undefined, { skipTriage: true })
      await qc.execute({ sql: `UPDATE tasks SET status = 'done' WHERE id = ?`, args: [blocker.id] })
      await qc.execute({
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', datetime('now'))`,
        args: [origin.id, blocker.id],
      })
      await qc.execute({ sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`, args: [origin.id] })

      await sub.ensureBlockerResolutionSubscriber(qc)
      await pub.publishWithRetry(qc, 'task.terminal', { taskId: blocker.id, reason: 'done' })
      await sub.drainBlockerResolution(qc)

      // origin should now be 'done' (propagated from the real fix task)
      const originAfter = await q.getTask(origin.id)
      expect(originAfter?.status).toBe('done')
    },
  )
})
