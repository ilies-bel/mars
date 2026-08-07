import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  ensureQueueSchema: typeof import('../../core/queue').ensureQueueSchema
  enqueueTask: typeof import('../../core/queue').enqueueTask
  addBlockers: typeof import('../../core/queue').addBlockers
  listAllBlockers: typeof import('../../core/queue').listAllBlockers
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
  await q.ensureQueueSchema()
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
  recoverySpawnedCount = 0,
): Promise<void> => {
  await q.addBlockers(taskId, [blockerTaskId])
  await q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET status = 'blocked', recovery_spawned_count = ? WHERE id = ?`,
    args: [recoverySpawnedCount, taskId],
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

  it('records blocker ordering timestamps as epoch milliseconds', async () => {
    const { q } = await loadModules(repo)
    const dependent = await q.enqueueTask('dependent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })

    await q.addBlockers(dependent.id, [blocker.id])

    const [edge] = await q.listAllBlockers(dependent.id)
    expect(edge).toMatchObject({
      causeKind: 'task',
      causeId: blocker.id,
    })
    expect(edge.createdAt).toEqual(expect.any(Number))
    expect(edge.createdAt).toBeGreaterThan(1_700_000_000_000)
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

  // Regression: a `dropped` blocker is terminal and can never reach `done`, so
  // a dependent waiting on it was stranded in `blocked` forever. Live case:
  // mars-95f2318e blocked on fix-3a03bbf2 (dropReason='arc-rescued'), cleared
  // by hand with `mars unblock`.
  it('releases a dependent whose only unsatisfied blocker is dropped', async () => {
    const { q, sub, pub } = await loadModules(repo)
    const dep = await q.enqueueTask('dependent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    await blockTask(q, dep.id, blocker.id)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'dropped' WHERE id = ?`,
      args: [blocker.id],
    })

    await sub.ensureBlockerResolutionSubscriber(q.resolveQueueClient())
    await pub.publishWithRetry(q.resolveQueueClient(), 'task.terminal', {
      taskId: blocker.id,
      reason: 'dropped',
    })
    const { processed } = await sub.drainBlockerResolution(q.resolveQueueClient())

    expect(processed).toBeGreaterThan(0)
    expect((await q.getTask(dep.id))?.status).toBe('queued')
  })

  it('keeps a dependent blocked when a dropped blocker is not its last unsettled one', async () => {
    const { q, sub, pub } = await loadModules(repo)
    const dep = await q.enqueueTask('dependent', undefined, { skipTriage: true })
    const droppedBlocker = await q.enqueueTask('dropped-blocker', undefined, { skipTriage: true })
    const liveBlocker = await q.enqueueTask('live-blocker', undefined, { skipTriage: true })
    await blockTask(q, dep.id, droppedBlocker.id)
    await q.addBlockers(dep.id, [liveBlocker.id])
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'dropped' WHERE id = ?`,
      args: [droppedBlocker.id],
    })

    await sub.ensureBlockerResolutionSubscriber(q.resolveQueueClient())
    await pub.publishWithRetry(q.resolveQueueClient(), 'task.terminal', {
      taskId: droppedBlocker.id,
      reason: 'dropped',
    })
    await sub.drainBlockerResolution(q.resolveQueueClient())

    expect((await q.getTask(dep.id))?.status).toBe('blocked')
  })

  // The `failed` half of the contract must NOT change: an ordinary failed
  // blocker still parks its dependents for operator resolution (CLAUDE.md
  // § Blockers — "the failure does not cascade down the chain").
  it('still strands a dependent behind an ordinary failed blocker (no cascade release)', async () => {
    const { q, sub, pub } = await loadModules(repo)
    const dep = await q.enqueueTask('dependent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    await blockTask(q, dep.id, blocker.id)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [blocker.id],
    })

    await sub.ensureBlockerResolutionSubscriber(q.resolveQueueClient())
    await pub.publishWithRetry(q.resolveQueueClient(), 'task.terminal', {
      taskId: blocker.id,
      reason: 'failed',
    })
    await sub.drainBlockerResolution(q.resolveQueueClient())

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
      sql: `UPDATE tasks SET status = 'blocked', recovery_spawned_count = 0 WHERE id = ?`,
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
//   1. The parked task's retry budget was exhausted (high recovery_spawned_count).
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

      const MAIN_COMMITER_PAYLOAD = JSON.stringify({ recipe: 'main-commiter', integrationBranch: 'main' })
      const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString()

      // Source task with high recovery_spawned_count (budget = 3, so recovery_spawned_count = 10 is exhausted)
      const src = await q.enqueueTask('implement-feature', undefined, { skipTriage: true })
      await qc.execute({ sql: `UPDATE tasks SET recovery_spawned_count = 10 WHERE id = ?`, args: [src.id] })

      // Older done main-committer C1 with fix_for_task_id = src.id (pre-ADR-0040 residue)
      const c1Id = `fix-old1-${src.id.slice(0, 6)}`
      await qc.execute({
        sql: `INSERT INTO tasks (id, prompt, status, kind, author_kind, author_name, fix_for_task_id, recovery_spawned_count, origin_id, priority, recovery_payload, created_at, updated_at)
              VALUES (?, 'clean main (old)', 'done', 'fix', 'agent', 'main-commiter-spawn', ?, 0, ?, 3, ?, ?, ?)`,
        args: [c1Id, src.id, src.id, MAIN_COMMITER_PAYLOAD, minutesAgo(5), minutesAgo(4)],
      })

      // New main-committer C2: the one that just completed
      const c2Id = `fix-new-${src.id.slice(0, 6)}`
      await qc.execute({
        sql: `INSERT INTO tasks (id, prompt, status, kind, author_kind, author_name, fix_for_task_id, recovery_spawned_count, origin_id, priority, recovery_payload, created_at, updated_at)
              VALUES (?, 'clean main (new)', 'done', 'fix', 'agent', 'main-commiter-spawn', ?, 0, ?, 3, ?, ?, ?)`,
        args: [c2Id, src.id, src.id, MAIN_COMMITER_PAYLOAD, minutesAgo(1), minutesAgo(0)],
      })

      // Park src behind C2 (raw SQL — ADR-0040 guard exemption for main-committers)
      await qc.execute({
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
        args: [src.id, c2Id, Date.now()],
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
    'non-main-committer recovery reaching done reconciles its origin to done (propagateRecoveryDone)',
    async () => {
      // Regression guard: ensure we did NOT accidentally break the normal
      // recovery-done path.  A real (non-main-committer) fix task with
      // fix_for_task_id = origin causes origin → done via propagateRecoveryDone
      // — the mechanism the daemon runs on a fix-task completion. This holds
      // regardless of the origin's recovery_spawned_count (the retry-budget silent-fail
      // gate was removed — mars-3d63fe52).
      const { q, sub } = await loadModules(repo)
      const qc = q.resolveQueueClient()
      // Import Arc after vi.resetModules() (inside loadModules) so it shares the
      // same module instance and DB binding as sub/q.
      const { Arc } = (await import('../../core/arc')) as {
        Arc: typeof import('../../core/arc').Arc
      }

      // Origin parked as blocked with a high recovery_spawned_count.
      const origin = await q.enqueueTask('origin-task', undefined, { skipTriage: true })
      await qc.execute({
        sql: `UPDATE tasks SET status = 'blocked', recovery_spawned_count = 10 WHERE id = ?`,
        args: [origin.id],
      })

      // Real recovery task (kind='fix', no recovery_payload → not a main-committer)
      const fixId = `fix-real-${origin.id.slice(0, 6)}`
      await qc.execute({
        sql: `INSERT INTO tasks (id, prompt, status, kind, author_kind, author_name, fix_for_task_id, recovery_spawned_count, origin_id, priority, recovery_payload, created_at, updated_at)
              VALUES (?, 'fix the code', 'done', 'fix', 'agent', 'recovery-spawn', ?, 0, ?, 3, NULL, ?, ?)`,
        args: [fixId, origin.id, origin.id, new Date(Date.now() - 60_000).toISOString(), new Date().toISOString()],
      })

      await sub.ensureBlockerResolutionSubscriber(qc)

      // The daemon calls propagateRecoveryDone(origin) when a real fix task lands done.
      const propagation = await Arc.load(origin.id).propagateRecoveryDone()
      expect(propagation.originFlipped).toBe(true)

      // origin should now be 'done' (propagated from the real fix task)
      const originAfter = await q.getTask(origin.id)
      expect(originAfter?.status).toBe('done')
    },
  )
})

// Regression: an origin whose one-shot recovery FAILS must end in `failed`,
// never `blocked`.
//
// Incident (measured live, 17 origins): a recovery Chore failed, the escalation
// row was raised correctly, but nothing ever transitioned the origin. It sat in
// `blocked` behind the one blocker edge that can never reach `done` (a recovery
// is a leaf and is never re-run — ADR-0040). `blocked` is not terminal, so
// `mars purge` refused it and `mars restart` refused it: permanently stranded.
//
// CLAUDE.md § Blockers / ADR-0040: "if it fails for any reason … the origin goes
// to `failed` with one actionable action queue item and the operator resolves it
// explicitly (e.g. `mars restart`)."
// ---------------------------------------------------------------------------
describe('blocker-resolution: a failed recovery must fail its origin, not strand it in blocked', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-dead-recovery-test-'))
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

  /**
   * Build the exact live shape: an origin parked in `blocked` behind its own
   * failed recovery Chore. The edge is inserted with raw SQL because
   * `addBlockers` rejects any edge touching a recovery task (ADR-0040 leaf
   * guard) — the origin→recovery edge is written by the recovery-spawn path.
   */
  const strandOriginOnFailedRecovery = async (
    q: QueueModule,
    originPrompt = 'implement-feature',
  ): Promise<{ originId: string; recoveryId: string }> => {
    const qc = q.resolveQueueClient()
    const origin = await q.enqueueTask(originPrompt, undefined, { skipTriage: true })
    const recoveryId = `fix-${origin.id.slice(0, 8)}`
    const now = new Date().toISOString()
    const blockerCreatedAt = Date.now()
    await qc.execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, author_kind, author_name, fix_for_task_id, recovery_spawned_count, origin_id, priority, failure_reason, failure_signature, created_at, updated_at)
            VALUES (?, 'fix the code', 'failed', 'fix', 'agent', 'recovery-spawn', ?, 0, ?, 3, ?, ?, ?, ?)`,
      args: [
        recoveryId,
        origin.id,
        origin.id,
        'recovery_failed:code/agent-nonzero-exit: boom',
        'code/agent-nonzero-exit',
        now,
        now,
      ],
    })
    await qc.execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
            VALUES (?, ?, 'confirmed', ?)`,
      args: [origin.id, recoveryId, blockerCreatedAt],
    })
    await qc.execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [origin.id],
    })
    return { originId: origin.id, recoveryId }
  }

  it('drains task.terminal { reason: failed } for a recovery and fails its origin', async () => {
    const { q, sub, pub } = await loadModules(repo)
    const qc = q.resolveQueueClient()
    const { originId, recoveryId } = await strandOriginOnFailedRecovery(q)

    expect((await q.getTask(originId))?.status).toBe('blocked')

    await sub.ensureBlockerResolutionSubscriber(qc)
    await pub.publishWithRetry(qc, 'task.terminal', { taskId: recoveryId, reason: 'failed' })
    const { processed } = await sub.drainBlockerResolution(qc)

    expect(processed).toBeGreaterThan(0)
    const originAfter = await q.getTask(originId)
    // The whole point: terminal, so `mars restart` / `mars purge` accept it.
    expect(originAfter?.status).toBe('failed')
    expect(originAfter?.status).not.toBe('blocked')
    expect(originAfter?.failureReason).toContain('origin_recovery_failed:')
    expect(originAfter?.failureReason).toContain(recoveryId)
  })

  it('does not cascade the failure to the origin’s own dependents', async () => {
    // CLAUDE.md: "A blocker that ends in `failed` leaves its dependents waiting
    // in `blocked` … the failure does not cascade down the chain."
    const { q, sub, pub } = await loadModules(repo)
    const qc = q.resolveQueueClient()
    const { originId, recoveryId } = await strandOriginOnFailedRecovery(q)

    const dep = await q.enqueueTask('downstream-of-origin', undefined, { skipTriage: true })
    await q.addBlockers(dep.id, [originId])
    await qc.execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [dep.id],
    })

    await sub.ensureBlockerResolutionSubscriber(qc)
    await pub.publishWithRetry(qc, 'task.terminal', { taskId: recoveryId, reason: 'failed' })
    await sub.drainBlockerResolution(qc)

    expect((await q.getTask(originId))?.status).toBe('failed')
    // Dependent keeps waiting — it must NOT be failed along with the origin.
    expect((await q.getTask(dep.id))?.status).toBe('blocked')
  })

  it('leaves a task blocked on an ordinary (non-recovery) failed blocker alone', async () => {
    const { q, sub, pub } = await loadModules(repo)
    const qc = q.resolveQueueClient()
    const dep = await q.enqueueTask('dependent', undefined, { skipTriage: true })
    const blocker = await q.enqueueTask('ordinary-prerequisite', undefined, {
      skipTriage: true,
    })
    await q.addBlockers(dep.id, [blocker.id])
    await qc.execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [dep.id],
    })
    await qc.execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [blocker.id],
    })

    await sub.ensureBlockerResolutionSubscriber(qc)
    await pub.publishWithRetry(qc, 'task.terminal', { taskId: blocker.id, reason: 'failed' })
    const { processed } = await sub.drainBlockerResolution(qc)

    expect(processed).toBe(0)
    expect((await q.getTask(dep.id))?.status).toBe('blocked')
  })

  it('startup reconcile sweep heals origins stranded before the live path existed', async () => {
    // The 17 live rows were stranded with no pending outbox event to replay, so
    // the subscriber alone cannot reach them — the boot sweep must.
    const { q } = await loadModules(repo)
    const a = await strandOriginOnFailedRecovery(q, 'stranded-one')
    const b = await strandOriginOnFailedRecovery(q, 'stranded-two')

    const { failOriginsStrandedOnFailedRecovery } = await import(
      '../../core/daemon/reconcile-blocker-drift'
    )

    const failed = await failOriginsStrandedOnFailedRecovery()
    expect(failed.sort()).toEqual([a.originId, b.originId].sort())
    expect((await q.getTask(a.originId))?.status).toBe('failed')
    expect((await q.getTask(b.originId))?.status).toBe('failed')

    // Idempotent: a second boot finds nothing left to repair.
    expect(await failOriginsStrandedOnFailedRecovery()).toEqual([])
  })

  it('leaves a source task parked behind a failed main-committer alone', async () => {
    // A main-committer cleans the integration branch; it does not carry the
    // source task's work. Its failure is owned by the dead-committer release
    // path, which RE-QUEUES the source once main is clean — failing it here
    // would kill work that path intends to resume.
    const { q, sub, pub } = await loadModules(repo)
    const qc = q.resolveQueueClient()
    const src = await q.enqueueTask('source-behind-committer', undefined, {
      skipTriage: true,
    })
    const committerId = `fix-mc-${src.id.slice(0, 6)}`
    const now = new Date().toISOString()
    const blockerCreatedAt = Date.now()
    await qc.execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, author_kind, author_name, fix_for_task_id, recovery_spawned_count, origin_id, priority, recovery_payload, created_at, updated_at)
            VALUES (?, 'clean main', 'failed', 'fix', 'agent', 'main-commiter-spawn', ?, 0, ?, 3, ?, ?, ?)`,
      args: [
        committerId,
        src.id,
        src.id,
        JSON.stringify({ recipe: 'main-commiter', integrationBranch: 'main' }),
        now,
        now,
      ],
    })
    await qc.execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
            VALUES (?, ?, 'confirmed', ?)`,
      args: [src.id, committerId, blockerCreatedAt],
    })
    await qc.execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [src.id],
    })

    await sub.ensureBlockerResolutionSubscriber(qc)
    await pub.publishWithRetry(qc, 'task.terminal', { taskId: committerId, reason: 'failed' })
    await sub.drainBlockerResolution(qc)

    expect((await q.getTask(src.id))?.status).toBe('blocked')

    const { failOriginsStrandedOnFailedRecovery } = await import(
      '../../core/daemon/reconcile-blocker-drift'
    )
    expect(await failOriginsStrandedOnFailedRecovery()).toEqual([])
    expect((await q.getTask(src.id))?.status).toBe('blocked')
  })

  it('an origin failed by its dead recovery never spawns a second recovery', async () => {
    // The repair emits task.failed for the ORIGIN. By then the origin's recovery
    // is terminal, so the outstanding-fix dedup no longer suppresses a spawn —
    // without the recovery-spawner gate this would hand the origin a SECOND
    // recovery and restart the strand cycle.
    const { q, sub, pub } = await loadModules(repo)
    const qc = q.resolveQueueClient()
    const { originId, recoveryId } = await strandOriginOnFailedRecovery(q)

    const spawner = (await import('./recovery-spawn')) as unknown as {
      ensureRecoverySpawner: typeof import('./recovery-spawn').ensureRecoverySpawner
      drainRecoverySpawner: typeof import('./recovery-spawn').drainRecoverySpawner
    }

    await sub.ensureBlockerResolutionSubscriber(qc)
    await spawner.ensureRecoverySpawner(qc)

    await pub.publishWithRetry(qc, 'task.terminal', { taskId: recoveryId, reason: 'failed' })
    await sub.drainBlockerResolution(qc)
    expect((await q.getTask(originId))?.status).toBe('failed')

    // Drain the recovery-spawner over the origin's own task.failed event.
    await spawner.drainRecoverySpawner(qc)

    const fixes = await qc.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [originId],
    })
    expect(fixes.rows.length).toBe(1)
    expect((fixes.rows[0] as unknown as { id: string }).id).toBe(recoveryId)
    // And the origin stays terminal — never reopened into a new episode.
    expect((await q.getTask(originId))?.status).toBe('failed')
  })
})

// Regression: mars-f2034bb9 — recovery done must flip origin to done, never to queued.
//
// Incident (daniel-assistant): recovery fix-78cb1033 ran on origin's worktree,
// merged the work, reached 'done', then origin mars-33fe7311 went to 'queued'
// instead of 'done'. Operator had to `mars drop --force` to stop it re-running.
//
// Root cause: two independent paths react to a recovery reaching done:
//   (1) inline daemon handler → calls propagateRecoveryDone() → flips origin done.
//   (2) blocker-resolution subscriber → calls unblockByCompletion(fixId) → finds
//       origin blocked on fix, re-queues it (generic unblock, no recovery awareness).
// When the subscriber drained before the inline handler, (2) won the race and
// origin landed in 'queued'. From there a new coder dispatch was imminent.
//
// Fix: make unblockByCompletion recovery-aware. When the completing task is a
// non-main-committer fix whose fixForTaskId === dependent.id, route through
// propagateRecoveryDone instead of plain re-queue. The two paths then converge
// regardless of drain order (propagateRecoveryDone is idempotent on done).
// ---------------------------------------------------------------------------
describe('blocker-resolution: recovery done must flip origin to done (mars-f2034bb9)', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-recovery-done-test-'))
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

  /**
   * Build the incident shape: origin blocked on its own recovery.
   * The recovery has kind='fix', fixForTaskId=origin.id (non-main-committer).
   */
  const buildOriginBlockedOnRecovery = async (
    q: QueueModule,
    qc: ReturnType<QueueModule['resolveQueueClient']>,
    opts: { recoveryPayload?: string } = {},
  ): Promise<{ originId: string; fixId: string }> => {
    const origin = await q.enqueueTask('implement-feature', undefined, { skipTriage: true })
    const fixId = `fix-${origin.id.slice(0, 8)}`
    const now = new Date().toISOString()
    await qc.execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, author_kind, author_name, fix_for_task_id, recovery_spawned_count, origin_id, priority, recovery_payload, created_at, updated_at)
            VALUES (?, 'fix the code', 'done', 'fix', 'agent', 'recovery-spawn', ?, 0, ?, 3, ?, ?, ?)`,
      args: [fixId, origin.id, origin.id, opts.recoveryPayload ?? null, now, now],
    })
    await qc.execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
      args: [origin.id, fixId, Date.now()],
    })
    await qc.execute({
      sql: `UPDATE tasks SET status = 'blocked', recovery_spawned_count = 1 WHERE id = ?`,
      args: [origin.id],
    })
    return { originId: origin.id, fixId }
  }

  it('subscriber-first order: draining task.terminal{fixId, done} flips origin to done (not queued)', async () => {
    // Reproduces the drain-first race: subscriber processes fix.terminal before
    // the inline daemon handler's propagateRecoveryDone has run.
    // Origin MUST end up 'done', never 'queued', so no spurious coder dispatch fires.
    const { q, sub, pub } = await loadModules(repo)
    const qc = q.resolveQueueClient()
    const { originId, fixId } = await buildOriginBlockedOnRecovery(q, qc)

    await sub.ensureBlockerResolutionSubscriber(qc)
    // Subscriber drains BEFORE propagateRecoveryDone is ever called by the server.
    await pub.publishWithRetry(qc, 'task.terminal', { taskId: fixId, reason: 'done' })
    const { processed } = await sub.drainBlockerResolution(qc)

    expect(processed).toBeGreaterThan(0)
    // Critical: origin must be done, never queued.
    const originAfter = await q.getTask(originId)
    expect(originAfter?.status).toBe('done')
    expect(originAfter?.status).not.toBe('queued')
  })

  it('propagate-first order: propagateRecoveryDone runs first; subscriber drain is a no-op that leaves origin done', async () => {
    // Inline handler calls propagateRecoveryDone before subscriber drains.
    // Subscriber drain must be a no-op (not re-queue the already-done origin).
    const { q, sub, pub } = await loadModules(repo)
    const qc = q.resolveQueueClient()
    const { Arc } = (await import('../../core/arc')) as {
      Arc: typeof import('../../core/arc').Arc
    }
    const { originId, fixId } = await buildOriginBlockedOnRecovery(q, qc)

    await sub.ensureBlockerResolutionSubscriber(qc)

    // Inline handler path: propagateRecoveryDone runs first.
    const propagation = await Arc.load(originId).propagateRecoveryDone()
    expect(propagation.originFlipped).toBe(true)
    expect((await q.getTask(originId))?.status).toBe('done')

    // Now publish the fix's terminal event and drain: must be a no-op.
    await pub.publishWithRetry(qc, 'task.terminal', { taskId: fixId, reason: 'done' })
    await sub.drainBlockerResolution(qc)

    // Origin still done — not re-queued by the subscriber.
    expect((await q.getTask(originId))?.status).toBe('done')
  })

  it('main-committer exception: a main-committer recovery done re-queues origin (not marks done)', async () => {
    // A main-committer cleans the integration branch; it does not deliver the
    // origin's work. When it completes, the origin must be RE-QUEUED so the
    // origin can retry on the clean branch — NOT marked done.
    const { q, sub, pub } = await loadModules(repo)
    const qc = q.resolveQueueClient()
    const MAIN_COMMITER_PAYLOAD = JSON.stringify({ recipe: 'main-commiter', integrationBranch: 'main' })
    const { originId, fixId } = await buildOriginBlockedOnRecovery(q, qc, {
      recoveryPayload: MAIN_COMMITER_PAYLOAD,
    })

    await sub.ensureBlockerResolutionSubscriber(qc)
    await pub.publishWithRetry(qc, 'task.terminal', { taskId: fixId, reason: 'done' })
    const { processed } = await sub.drainBlockerResolution(qc)

    expect(processed).toBeGreaterThan(0)
    // Main-committer exception: origin re-queued, not done.
    const originAfter = await q.getTask(originId)
    expect(originAfter?.status).toBe('queued')
    expect(originAfter?.status).not.toBe('done')
  })

  it('origin dependents are unblocked when recovery done propagates origin to done', async () => {
    // When the recovery done flips origin to done, anything blocked on origin
    // must be released (via propagateRecoveryDone → unblockByCompletion(origin)).
    const { q, sub, pub } = await loadModules(repo)
    const qc = q.resolveQueueClient()
    const { originId, fixId } = await buildOriginBlockedOnRecovery(q, qc)

    // Add a downstream task blocked on the origin.
    const downstream = await q.enqueueTask('depends-on-origin', undefined, { skipTriage: true })
    await qc.execute({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
      args: [downstream.id, originId, Date.now()],
    })
    await qc.execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [downstream.id],
    })

    await sub.ensureBlockerResolutionSubscriber(qc)
    await pub.publishWithRetry(qc, 'task.terminal', { taskId: fixId, reason: 'done' })
    await sub.drainBlockerResolution(qc)

    expect((await q.getTask(originId))?.status).toBe('done')
    // Downstream must be released to queued via the cascade.
    expect((await q.getTask(downstream.id))?.status).toBe('queued')
  })
})

// Regression: mars-f109e203 — late recovery success must resurrect its origin to done.
//
// Incident (2026-07-06, origin mars-50e3b511 / recovery fix-a2b92b18):
//   1. Recovery initially failed → unblock sweep stamped origin 'failed'.
//   2. Operator ran `mars restart fix-a2b92b18`; recovery succeeded.
//   3. Origin stayed 'failed' forever because propagateRecoveryDone()
//      previously returned early for any non-done terminal status.
//
// Fix (834fdaa1): only 'done' is a genuine idempotent no-op; 'failed' and
// 'dropped' origins are reconciled to 'done' — a successful recovery is
// authoritative regardless of what the retry-budget guard previously stamped.
// The fix emits task.terminal so the blocker-cascade subscriber can replay on
// daemon restart and unblock any stranded dependents.
// ---------------------------------------------------------------------------
describe('blocker-resolution: late recovery success must resurrect failed origin (mars-f109e203)', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-late-recovery-test-'))
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
    'origin in failed + recovery transitions to done => origin becomes done and sole blocked dependent flips to queued',
    async () => {
      // Arrange: origin is 'failed' (stamped by unblock sweep when first recovery
      // attempt exhausted the budget). A dependent is still stranded in 'blocked'.
      process.env.MARS_FIX_RETRY_BUDGET = '3'
      const { q, sub } = await loadModules(repo)
      const qc = q.resolveQueueClient()
      // Import Arc after vi.resetModules() (called inside loadModules) so it
      // shares the same module instance and DB binding as sub/q.
      const { Arc } = (await import('../../core/arc')) as {
        Arc: typeof import('../../core/arc').Arc
      }

      const origin = await q.enqueueTask('implement-feature', undefined, { skipTriage: true })
      // Origin failed when the first recovery attempt exhausted its retry budget.
      await qc.execute({
        sql: `UPDATE tasks SET status = 'failed', recovery_spawned_count = 5 WHERE id = ?`,
        args: [origin.id],
      })

      // Dependent is stranded in 'blocked' on the origin.
      const dep = await q.enqueueTask('dep-on-origin', undefined, { skipTriage: true })
      await qc.execute({
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
              VALUES (?, ?, 'confirmed', ?)`,
        args: [dep.id, origin.id, Date.now()],
      })
      await qc.execute({
        sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
        args: [dep.id],
      })

      // Recovery task (kind='fix', fix_for_task_id=origin.id) has now succeeded
      // — the operator restarted it and it completed successfully.
      const fixId = `fix-${origin.id.slice(0, 8)}`
      await qc.execute({
        sql: `INSERT INTO tasks (id, prompt, status, kind, author_kind, author_name, fix_for_task_id, recovery_spawned_count, origin_id, priority, created_at, updated_at)
              VALUES (?, 'fix the code', 'done', 'fix', 'agent', 'recovery-spawn', ?, 0, ?, 3, ?, ?)`,
        args: [fixId, origin.id, origin.id, new Date().toISOString(), new Date().toISOString()],
      })

      await sub.ensureBlockerResolutionSubscriber(qc)

      // Act: simulate what the daemon does when a fix task reaches 'done'.
      // propagateRecoveryDone() must NOT early-return just because origin is
      // 'failed' — the successful recovery is the authoritative signal.
      const propagation = await Arc.load(origin.id).propagateRecoveryDone()

      // Assert — origin must be flipped to done.
      expect(propagation.originFlipped).toBe(true)
      expect((await q.getTask(origin.id))?.status).toBe('done')

      // propagateRecoveryDone emits task.terminal{origin, done} into the
      // durable outbox so the subscriber can replay on daemon restart.
      // Drain it now: the subscriber calls unblockByCompletion(origin.id) which
      // finds the stranded dependent and re-queues it.
      await sub.drainBlockerResolution(qc)
      expect((await q.getTask(dep.id))?.status).toBe('queued')
    },
  )
})
