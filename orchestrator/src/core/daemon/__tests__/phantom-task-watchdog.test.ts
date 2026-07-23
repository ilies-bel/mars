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
  ZERO_EVENTS_GRACE_MS: typeof import('../phantom-task-watchdog').ZERO_EVENTS_GRACE_MS
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

  it('re-queues an orphaned running task (no in-flight entry) whose updatedAt exceeds the ceiling', async () => {
    // A 'running' task with NO in-flight entry is definitely from a prior daemon.
    // The phantom-task watchdog must RE-QUEUE it (not fail it) so the work resumes.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()
    // Pass empty inFlight — no entry for this task in the current daemon.
    const { failed, requeued } = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)

    expect(failed).not.toContain(task.id)
    expect(requeued).toContain(task.id)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('queued')
    // Branch/worktree/session fields cleared so the next dispatch starts fresh.
    expect(reloaded?.branch).toBeNull()
    expect(reloaded?.worktreePath).toBeNull()

    // reclaimSlot must NOT be called — there is no in-flight slot to reclaim.
    expect(reclaimSlot).not.toHaveBeenCalled()

    // No action-queue item: re-queue is a transparent recovery, not an alert.
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
  })

  it('still fails a running task that has an in-flight entry but no PID and exceeds the ceiling', async () => {
    // A task WITH an in-flight entry (this daemon dispatched it) but no PID
    // recorded should still be phantom-failed after the ceiling.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()
    // Provide an in-flight entry WITHOUT a pid.
    const inFlightEntries = [{ taskId: task.id, kind: 'implement' as const, startedAt: nowMs - 35 * 60_000 }]
    const { failed, requeued } = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, undefined, nowMs)

    expect(failed).toContain(task.id)
    expect(requeued).not.toContain(task.id)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('code')

    expect(reclaimSlot).toHaveBeenCalledWith(task.id, 'implement')

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

  it('re-detecting a phantom bumps the existing action-queue item (no retry storm) — in-flight entry path', async () => {
    // This test uses an in-flight entry WITH no PID so the fail path fires,
    // verifying that re-detecting a phantom doesn't spawn duplicate AQ items.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()
    // Provide an in-flight entry so the fail path fires (not the re-queue path).
    const inFlightEntries = [{ taskId: task.id, kind: 'implement' as const, startedAt: nowMs - 35 * 60_000 }]

    // First sweep: marks the task failed and raises one item.
    const first = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, undefined, nowMs)
    expect(first.failed).toHaveLength(1)

    const itemsBefore = await actionQueue.listActionQueueItems('open')
    expect(itemsBefore).toHaveLength(1)
    const firstItemId = itemsBefore[0].id

    // Second sweep: the task is now 'failed' — watchdog should not produce a new item.
    const second = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, undefined, nowMs)
    expect(second.failed).toHaveLength(0)

    const itemsAfter = await actionQueue.listActionQueueItems('open')
    expect(itemsAfter).toHaveLength(1)
    expect(itemsAfter[0].id).toBe(firstItemId)
  })

  it('re-queuing is idempotent: a second sweep finds the task queued (not running) and skips it', async () => {
    // After the first sweep re-queues an orphaned running task, a second sweep
    // must not touch it (it is no longer in a phantom status).
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()

    // First sweep: re-queues the orphaned task.
    const first = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)
    expect(first.requeued).toContain(task.id)
    expect(first.failed).toHaveLength(0)

    // Second sweep: task is now 'queued' — not in a scanned status, untouched.
    const second = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)
    expect(second.requeued).toHaveLength(0)
    expect(second.failed).toHaveLength(0)

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
  })

  it('handles multiple orphaned running tasks in one sweep, re-queuing each', async () => {
    // With no in-flight entries, both stale running tasks are re-queued, not failed.
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
    const { failed, requeued } = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)

    expect(failed).toHaveLength(0)
    expect(requeued).toHaveLength(2)
    expect(requeued).toContain(t1.id)
    expect(requeued).toContain(t2.id)

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
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

  it('does NOT fail a running task when its PID is alive and actively producing events', async () => {
    // Simulate a legitimately running task: alive PID + recent activity heartbeat.
    // Both the ceiling path and the zero-events path must leave this task alone.
    const { q, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    const recentUpdatedAt = new Date(nowMs - 5 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [recentUpdatedAt, task.id],
    })

    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 5 * 60_000,
        pid: 12345,
        // Recent heartbeat: coder is streaming output, not a phantom.
        lastActivityMs: nowMs - 1 * 60_000,
      },
    ]
    const isAlive = vi.fn().mockReturnValue(true) // PID is alive
    const reclaimSlot = vi.fn()

    const { failed } = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, isAlive, nowMs)

    expect(failed).not.toContain(task.id)
    expect(reclaimSlot).not.toHaveBeenCalled()
  })

  it('alive pid + stale heartbeat exceeds ceiling is treated as phantom', async () => {
    const { q, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    // updatedAt is old — but that alone does NOT trigger ceiling for alive PIDs.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 35 * 60_000,
        pid: 12345,
        // lastActivityMs is also stale (35 min ago) — process is hung
        lastActivityMs: nowMs - 35 * 60_000,
      },
    ]
    const isAlive = vi.fn().mockReturnValue(true) // PID is alive but heartbeat stale
    const reclaimSlot = vi.fn()

    const { failed } = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, isAlive, nowMs)

    // Should be failed: alive PID but heartbeat activity ceiling exceeded
    expect(failed).toContain(task.id)
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
  })

  it('alive pid + stale row + recent heartbeat is NOT phantom', async () => {
    const { q, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    // updatedAt is old — row would trigger ceiling if checked in isolation
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 35 * 60_000,
        pid: 12345,
        // lastActivityMs is recent (1 min ago) — heartbeat is alive
        lastActivityMs: nowMs - 1 * 60_000,
      },
    ]
    const isAlive = vi.fn().mockReturnValue(true) // PID is alive
    const reclaimSlot = vi.fn()

    const { failed } = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, isAlive, nowMs)

    // Must NOT be killed: alive PID + recent heartbeat overrides stale updatedAt
    expect(failed).not.toContain(task.id)
    expect(reclaimSlot).not.toHaveBeenCalled()
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('running')
  })

  it('alive pid + stale row + no events past grace window is killed via zero-events (not ceiling)', async () => {
    // An alive process started 35 minutes ago with ZERO events is a phantom —
    // the zero-events path fires and kills it faster than the 30-min ceiling.
    // This test confirms the kill reason is 'zero-events', not 'ceiling'.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    // updatedAt is old — but that alone does NOT drive the kill for alive PIDs.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 35 * 60_000, // 35 min since spawn — well past 3-min grace
        pid: 12345,
        // No lastActivityMs — process has emitted zero events in 35 minutes
      },
    ]
    const isAlive = vi.fn().mockReturnValue(true) // PID is alive but zombie-quiet
    const reclaimSlot = vi.fn()

    const { failed } = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, isAlive, nowMs)

    // Killed by the zero-events path, not updatedAt ceiling.
    expect(failed).toContain(task.id)
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReasonCode).toBe('phantom-task:zero-events')

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].payload).toMatchObject({ reason: 'zero-events' })
  })
})

// ── Zero-event fast-kill ─────────────────────────────────────────────────────

describe('sweepPhantomTasks — zero-events fast-kill', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_PHANTOM_WATCHDOG_CEILING_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('kills a running task with an alive PID that has emitted zero events past the grace window', async () => {
    // An alive subprocess that produces no events for longer than ZERO_EVENTS_GRACE_MS
    // is almost certainly stuck at startup — kill it fast rather than waiting the full ceiling.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    // Task row is freshly updated — NOT stale by ceiling standards.
    const recentUpdatedAt = new Date(nowMs - 2 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [recentUpdatedAt, task.id],
    })

    // In-flight entry: alive PID, no lastActivityMs (zero events), started 4 min ago
    // (past the 3-min ZERO_EVENTS_GRACE_MS).
    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 4 * 60_000, // 4 minutes ago — past grace window
        pid: 12345,
        // no lastActivityMs → zero events produced
      },
    ]
    const isAlive = vi.fn().mockReturnValue(true) // PID is alive
    const reclaimSlot = vi.fn()

    const { failed } = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, isAlive, nowMs)

    // Must be fast-killed despite the row being within the normal ceiling.
    expect(failed).toContain(task.id)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('code')
    expect(reloaded?.failureReasonCode).toBe('phantom-task:zero-events')

    expect(reclaimSlot).toHaveBeenCalledWith(task.id, 'implement')

    // Action-queue item raised with the zero-events reason.
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe(watchdog.PHANTOM_TASK_KIND)
    expect(items[0].payload).toMatchObject({ reason: 'zero-events' })
  })

  it('does NOT kill a running task with alive PID and zero events within the grace window', async () => {
    // A newly dispatched task hasn't had time to produce events yet — do not kill it.
    const { q, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    const recentUpdatedAt = new Date(nowMs - 1 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [recentUpdatedAt, task.id],
    })

    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 1 * 60_000, // 1 minute ago — within the 3-min grace window
        pid: 12345,
        // no lastActivityMs → zero events produced, but still within grace
      },
    ]
    const isAlive = vi.fn().mockReturnValue(true)
    const reclaimSlot = vi.fn()

    const { failed } = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, isAlive, nowMs)

    expect(failed).not.toContain(task.id)
    expect(reclaimSlot).not.toHaveBeenCalled()

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('running')
  })

  it('ZERO_EVENTS_GRACE_MS is a named constant shorter than DEFAULT_CEILING_MS', async () => {
    // Guard: the grace window must be meaningfully shorter than the ceiling —
    // otherwise the fast-kill provides no benefit over the existing ceiling path.
    // This test will fail if someone accidentally sets ZERO_EVENTS_GRACE_MS >= DEFAULT_CEILING_MS.
    const { watchdog } = await loadModules(repo)
    expect(watchdog.ZERO_EVENTS_GRACE_MS).toBeLessThan(watchdog.DEFAULT_CEILING_MS)
    expect(watchdog.ZERO_EVENTS_GRACE_MS).toBeGreaterThan(0)
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
