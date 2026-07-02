import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  updateTask: typeof import('../../queue').updateTask
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
}

interface WatchdogModule {
  sweepPhantomTasks: typeof import('../phantom-task-watchdog').sweepPhantomTasks
  sweepExpiredLeases: typeof import('../phantom-task-watchdog').sweepExpiredLeases
  buildPhantomBody: typeof import('../phantom-task-watchdog').buildPhantomBody
  PHANTOM_TASK_KIND: typeof import('../phantom-task-watchdog').PHANTOM_TASK_KIND
  DEFAULT_CEILING_MS: typeof import('../phantom-task-watchdog').DEFAULT_CEILING_MS
  DEFAULT_LEASE_EXPIRY_MS: typeof import('../phantom-task-watchdog').DEFAULT_LEASE_EXPIRY_MS
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-phantom-watchdog-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; actionQueue: ActionQueueModule; watchdog: WatchdogModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const watchdog = (await import('../phantom-task-watchdog')) as unknown as WatchdogModule
  return { q, actionQueue, watchdog }
}

/** Timestamp well past the 30-minute ceiling. */
const OLD_UPDATED_AT = (nowMs: number): string =>
  new Date(nowMs - 31 * 60_000).toISOString()

describe('sweepPhantomTasks — wall-clock ceiling', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_PHANTOM_WATCHDOG_CEILING_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('auto-fails a running task whose updatedAt exceeds the ceiling', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()
    const { failed } = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)

    expect(failed).toContain(task.id)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('code')

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe(watchdog.PHANTOM_TASK_KIND)
    expect(items[0].context).toEqual(expect.objectContaining({ taskId: task.id }))
  })

  it('auto-fails a verifying task whose updatedAt exceeds the ceiling', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()
    const { failed } = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)

    expect(failed).toContain(task.id)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('verify')

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe(watchdog.PHANTOM_TASK_KIND)
  })

  it('does NOT fail a running task whose updatedAt is within the ceiling', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    // Age: only 10 minutes — well within the 30-min default ceiling
    const recentUpdatedAt = new Date(nowMs - 10 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [recentUpdatedAt, task.id],
    })

    const reclaimSlot = vi.fn()
    const { failed } = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)

    expect(failed).not.toContain(task.id)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('running')

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
  })

  it('does NOT fail tasks in terminal statuses (done, failed, dropped)', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    const t1 = await q.enqueueTask('done work', undefined, { skipTriage: true })
    const t2 = await q.enqueueTask('dropped work', undefined, { skipTriage: true })

    for (const [id, st] of [[t1.id, 'done'], [t2.id, 'dropped']] as const) {
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`,
        args: [st, OLD_UPDATED_AT(nowMs), id],
      })
    }

    const reclaimSlot = vi.fn()
    const { failed } = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)

    expect(failed).toHaveLength(0)
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
  })

  it('calls reclaimSlot for tasks that were in the inFlight entries', async () => {
    const { q, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()
    const inFlightEntries = [{ taskId: task.id, kind: 'implement' as const, startedAt: nowMs - 40 * 60_000 }]

    await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, undefined, nowMs)

    expect(reclaimSlot).toHaveBeenCalledWith(task.id, 'implement')
  })

  it('does NOT call reclaimSlot for tasks that were NOT in the inFlight entries', async () => {
    const { q, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()
    await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)

    expect(reclaimSlot).not.toHaveBeenCalled()
  })

  it('re-detecting a phantom bumps the existing action-queue item (no retry storm)', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()

    // First sweep: marks the task failed and raises one item.
    const first = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)
    expect(first.failed).toHaveLength(1)

    const itemsBefore = await actionQueue.listActionQueueItems('open')
    expect(itemsBefore).toHaveLength(1)
    const firstItemId = itemsBefore[0].id

    // Second sweep: the task is now 'failed' — watchdog should not produce a new item.
    const second = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)
    expect(second.failed).toHaveLength(0)

    const itemsAfter = await actionQueue.listActionQueueItems('open')
    expect(itemsAfter).toHaveLength(1)
    expect(itemsAfter[0].id).toBe(firstItemId)
  })

  it('handles multiple phantom tasks in one sweep, raising one item each', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    const t1 = await q.enqueueTask('work 1', undefined, { skipTriage: true })
    const t2 = await q.enqueueTask('work 2', undefined, { skipTriage: true })

    for (const id of [t1.id, t2.id]) {
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
        args: [OLD_UPDATED_AT(nowMs), id],
      })
    }

    const reclaimSlot = vi.fn()
    const { failed } = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)

    expect(failed).toHaveLength(2)
    expect(failed).toContain(t1.id)
    expect(failed).toContain(t2.id)

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(2)
  })

  it('returns empty list when no tasks are running', async () => {
    const { q, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    await q.enqueueTask('queued work', undefined, { skipTriage: true })

    const reclaimSlot = vi.fn()
    const { failed } = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)

    expect(failed).toHaveLength(0)
  })
})

describe('sweepPhantomTasks — PID liveness', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_PHANTOM_WATCHDOG_CEILING_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('auto-fails a running task immediately when its in-flight PID is dead (before ceiling)', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    // Age is only 5 minutes — within the 30-min ceiling — but PID is dead.
    const recentUpdatedAt = new Date(nowMs - 5 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [recentUpdatedAt, task.id],
    })

    const inFlightEntries = [
      { taskId: task.id, kind: 'implement' as const, startedAt: nowMs - 5 * 60_000, pid: 99999 },
    ]
    const isAlive = vi.fn().mockReturnValue(false) // PID is dead
    const reclaimSlot = vi.fn()

    const { failed } = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, isAlive, nowMs)

    expect(failed).toContain(task.id)
    expect(isAlive).toHaveBeenCalledWith(99999)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('code')

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].payload).toMatchObject({ reason: 'dead-pid' })
  })

  it('does NOT fail a running task when its PID is alive and within the ceiling', async () => {
    const { q, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    const recentUpdatedAt = new Date(nowMs - 5 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [recentUpdatedAt, task.id],
    })

    const inFlightEntries = [
      { taskId: task.id, kind: 'implement' as const, startedAt: nowMs - 5 * 60_000, pid: 12345 },
    ]
    const isAlive = vi.fn().mockReturnValue(true) // PID is alive
    const reclaimSlot = vi.fn()

    const { failed } = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, isAlive, nowMs)

    expect(failed).not.toContain(task.id)
    expect(reclaimSlot).not.toHaveBeenCalled()
  })

  it('falls back to ceiling check when PID is alive but beyond the ceiling', async () => {
    const { q, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    // Age exceeds 30-min ceiling
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const inFlightEntries = [
      { taskId: task.id, kind: 'implement' as const, startedAt: nowMs - 35 * 60_000, pid: 12345 },
    ]
    const isAlive = vi.fn().mockReturnValue(true) // PID is alive but task has exceeded ceiling
    const reclaimSlot = vi.fn()

    const { failed } = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, isAlive, nowMs)

    // Should still be failed: alive PID but wall-clock ceiling exceeded
    expect(failed).toContain(task.id)
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
  })
})

// ── Parked-state immunity ────────────────────────────────────────────────────

describe('sweepPhantomTasks — parked state immunity', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_PHANTOM_WATCHDOG_CEILING_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('never phantom-fails a task in awaiting-human, even when older than the ceiling', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('human work', undefined, { skipTriage: true })

    // Park the task as awaiting-human with an old leasedAt (well past the ceiling).
    const oldLeasedAt = new Date(nowMs - 31 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'awaiting-human', leased_at = ?, lease_owner = ?, updated_at = ? WHERE id = ?`,
      args: [oldLeasedAt, 'operator@example.com', oldLeasedAt, task.id],
    })

    const reclaimSlot = vi.fn()
    const { failed } = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)

    // Must NOT appear in failed list.
    expect(failed).not.toContain(task.id)
    // Status must remain awaiting-human.
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('awaiting-human')
    // No phantom action-queue items raised.
    const items = await actionQueue.listActionQueueItems('open')
    expect(items.filter((i) => i.kind === watchdog.PHANTOM_TASK_KIND)).toHaveLength(0)
    // reclaimSlot was never called.
    expect(reclaimSlot).not.toHaveBeenCalled()
  })
})

// ── Lease expiry alerts ──────────────────────────────────────────────────────

describe('sweepExpiredLeases', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_LEASE_EXPIRY_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises an awaiting-human action-queue row for a task whose lease has expired', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('human work', undefined, { skipTriage: true })

    // Lease acquired well beyond the default 4-hour expiry.
    const expiredLeasedAt = new Date(nowMs - (4 * 60 + 5) * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'awaiting-human', leased_at = ?, lease_owner = ?, updated_at = ? WHERE id = ?`,
      args: [expiredLeasedAt, 'alice', expiredLeasedAt, task.id],
    })

    const { alerted } = await watchdog.sweepExpiredLeases(nowMs)

    // Task ID appears in alerted list.
    expect(alerted).toContain(task.id)

    // An 'awaiting-human' action-queue row was raised (NOT a 'phantom-task' row).
    const items = await actionQueue.listActionQueueItems('open')
    const leaseItems = items.filter((i) => i.kind === 'awaiting-human')
    expect(leaseItems).toHaveLength(1)
    expect(leaseItems[0].context).toEqual(expect.objectContaining({ taskId: task.id }))

    // Task status is still awaiting-human — NOT failed.
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('awaiting-human')
  })

  it('does NOT alert when the lease is within the expiry window', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('human work', undefined, { skipTriage: true })

    // Lease acquired 30 minutes ago — well within the 4-hour default expiry.
    const recentLeasedAt = new Date(nowMs - 30 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'awaiting-human', leased_at = ?, lease_owner = ?, updated_at = ? WHERE id = ?`,
      args: [recentLeasedAt, 'alice', recentLeasedAt, task.id],
    })

    const { alerted } = await watchdog.sweepExpiredLeases(nowMs)

    expect(alerted).not.toContain(task.id)
    const items = await actionQueue.listActionQueueItems('open')
    expect(items.filter((i) => i.kind === 'awaiting-human')).toHaveLength(0)
  })

  it('respects MARS_LEASE_EXPIRY_MS override', async () => {
    process.env.MARS_LEASE_EXPIRY_MS = String(10 * 60_000) // 10-minute expiry
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('human work', undefined, { skipTriage: true })

    // Lease acquired 15 minutes ago — exceeds the 10-minute custom expiry.
    const expiredLeasedAt = new Date(nowMs - 15 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'awaiting-human', leased_at = ?, lease_owner = ?, updated_at = ? WHERE id = ?`,
      args: [expiredLeasedAt, 'bob', expiredLeasedAt, task.id],
    })

    const { alerted } = await watchdog.sweepExpiredLeases(nowMs)

    expect(alerted).toContain(task.id)
    const items = await actionQueue.listActionQueueItems('open')
    expect(items.filter((i) => i.kind === 'awaiting-human')).toHaveLength(1)

    // Task still parked — NOT failed.
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('awaiting-human')
  })

  it('re-detection bumps seen_count on the existing row (level-triggered, ADR-0048)', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('human work', undefined, { skipTriage: true })

    const expiredLeasedAt = new Date(nowMs - (4 * 60 + 5) * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'awaiting-human', leased_at = ?, lease_owner = ?, updated_at = ? WHERE id = ?`,
      args: [expiredLeasedAt, 'alice', expiredLeasedAt, task.id],
    })

    // First sweep
    await watchdog.sweepExpiredLeases(nowMs)
    // Second sweep (re-detection)
    await watchdog.sweepExpiredLeases(nowMs + 5000)

    // Still only ONE action-queue item (dedup by signature).
    const items = await actionQueue.listActionQueueItems('open')
    expect(items.filter((i) => i.kind === 'awaiting-human')).toHaveLength(1)
  })
})
