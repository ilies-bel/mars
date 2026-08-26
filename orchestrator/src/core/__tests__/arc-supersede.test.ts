/**
 * Regression test: superseding a blocker task must release its dependents.
 *
 * Before the fix in arc.ts, the supersede path wrote a raw SQL UPDATE that
 * dropped the superseded task without emitting task.dropped / task.terminal
 * events. drainBlockerResolution subscribes to task.terminal and, without the
 * event, never ran. Dependents stayed stuck in 'blocked' until the next daemon
 * restart triggered orphanedBlockedScan — hours later.
 *
 * Acceptance criteria:
 *   (a) A task blocked-by a superseded task flips to 'queued' once
 *       drainBlockerResolution is called — no daemon restart required.
 *   (b) The superseded task itself is 'dropped' after the operation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  enqueueTask: typeof import('../queue').enqueueTask
  addBlockers: typeof import('../queue').addBlockers
  getTask: typeof import('../queue').getTask
  resolveQueueClient: typeof import('../queue').resolveQueueClient
}

interface BlockerResolutionMod {
  ensureBlockerResolutionSubscriber: typeof import('../../outbox/subscribers/blocker-resolution').ensureBlockerResolutionSubscriber
  drainBlockerResolution: typeof import('../../outbox/subscribers/blocker-resolution').drainBlockerResolution
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-arc-supersede-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueMod; sub: BlockerResolutionMod }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../queue')) as unknown as QueueMod
  await q.migrateQueueSchema()
  const sub = (await import(
    '../../outbox/subscribers/blocker-resolution'
  )) as unknown as BlockerResolutionMod
  return { q, sub }
}

describe('arc.supersede — blocker-resolution event emission', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('(a) releases a dependent to queued when its only blocker is superseded', async () => {
    // Setup: task A (the blocker) and task B (dependent, blocked on A).
    const { q, sub } = await loadModules(repo)

    const taskA = await q.enqueueTask('blocker task', undefined, { skipTriage: true })
    const taskB = await q.enqueueTask('dependent task', undefined, { skipTriage: true })

    // Wire the blocker edge and force B into 'blocked' status so only
    // drainBlockerResolution can flip it back to 'queued'.
    await q.addBlockers(taskB.id, [taskA.id])
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [taskB.id],
    })

    // Confirm the starting state.
    expect((await q.getTask(taskB.id))?.status).toBe('blocked')

    // Register the subscriber BEFORE the supersede so it sees the events
    // that enqueueTask emits inside the atomic block.
    await sub.ensureBlockerResolutionSubscriber(q.resolveQueueClient())

    // Supersede A: this creates a replacement task and drops A.
    // The fix ensures task.dropped + task.terminal are emitted in the same
    // transaction as the DROP UPDATE, so the subscriber can process them.
    await q.enqueueTask('replacement for A', undefined, {
      skipTriage: true,
      supersedes: taskA.id,
    })

    // (b) The superseded task must be dropped.
    expect((await q.getTask(taskA.id))?.status).toBe('dropped')

    // Drain the subscriber — B must flip to 'queued' without a restart.
    const { processed } = await sub.drainBlockerResolution(q.resolveQueueClient())

    expect(processed).toBeGreaterThan(0)
    // (a) The dependent must now be queued.
    expect((await q.getTask(taskB.id))?.status).toBe('queued')
  })

  it('a dependent with a second unsettled blocker stays blocked after supersede', async () => {
    // Ensure we do not release prematurely when a second active blocker exists.
    const { q, sub } = await loadModules(repo)

    const taskA = await q.enqueueTask('superseded blocker', undefined, { skipTriage: true })
    const taskC = await q.enqueueTask('still-active blocker', undefined, { skipTriage: true })
    const taskB = await q.enqueueTask('dependent task', undefined, { skipTriage: true })

    await q.addBlockers(taskB.id, [taskA.id, taskC.id])
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [taskB.id],
    })

    await sub.ensureBlockerResolutionSubscriber(q.resolveQueueClient())

    // Supersede A — C is still unsettled.
    await q.enqueueTask('replacement for A', undefined, {
      skipTriage: true,
      supersedes: taskA.id,
    })

    await sub.drainBlockerResolution(q.resolveQueueClient())

    // B must remain blocked because C is still active (queued).
    expect((await q.getTask(taskB.id))?.status).toBe('blocked')
  })
})
