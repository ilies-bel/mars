import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('does NOT phantom-fail a verifying task while isVerifyRunning returns true, even after 35+ min', async () => {
    // This is the remerge re-verify scenario: the task has been in 'verifying'
    // for 35 minutes (past the 30-min default ceiling), but the daemon's
    // acquireVerifySlot / releaseVerifySlot bracket tells us the verify is
    // still alive. The watchdog must skip it rather than killing a live verify.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('remerge: run full test suite', undefined, { skipTriage: true })

    // Age is 35 minutes — past the 30-min ceiling, would normally trigger a kill.
    const stalledUpdatedAt = new Date(nowMs - 35 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying', updated_at = ? WHERE id = ?`,
      args: [stalledUpdatedAt, task.id],
    })

    const reclaimSlot = vi.fn()
    // isVerifyRunning returns true — this daemon is actively verifying this task.
    const isVerifyRunning = vi.fn().mockReturnValue(true)
    const { failed } = await watchdog.sweepPhantomTasks(
      [],
      reclaimSlot,
      undefined,
      nowMs,
      undefined,
      isVerifyRunning,
    )

    // Must NOT be failed: the verify is live, just slow.
    expect(failed).not.toContain(task.id)
    expect(isVerifyRunning).toHaveBeenCalledWith(task.id)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('verifying')

    // No action-queue item raised — the task is healthy.
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
    expect(reclaimSlot).not.toHaveBeenCalled()
  })

  it('still fails a verifying task past the ceiling when isVerifyRunning returns false (orphaned)', async () => {
    // When the daemon cannot confirm the verify is live (isVerifyRunning=false),
    // the ceiling backstop still applies — this covers tasks orphaned from a
    // prior daemon restart.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('some work', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()
    // isVerifyRunning returns false — this task is not tracked by this daemon.
    const isVerifyRunning = vi.fn().mockReturnValue(false)
    const { failed } = await watchdog.sweepPhantomTasks(
      [],
      reclaimSlot,
      undefined,
      nowMs,
      undefined,
      isVerifyRunning,
    )

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
    expect(reloaded?.error).toContain('worker PID 99999 was not alive when checked')
    expect(reloaded?.error).toContain('last event: none recorded')

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].payload).toMatchObject({ reason: 'dead-pid' })
  })

  it('does NOT fail a running task when its PID is alive and actively producing events', async () => {
    // Simulate a legitimately running task: alive PID + recent activity heartbeat.
    // Both liveness and the activity ceiling must leave this task alone.
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

  it('does NOT fail a verifying task when in-flight entry has alive PID and fresh heartbeat', async () => {
    // Regression test for the remerge/verify-only ceiling-kill bug (mars-4934c485).
    //
    // Before the fix: acquireVerifySlot called releaseTracking(), removing the
    // in-flight entry. With no entry, the watchdog used case 2a (stale updatedAt
    // ceiling) and killed a long-running verify after 30 minutes.
    //
    // After the fix: the in-flight entry stays alive through the verify phase
    // (releaseTracking() is deferred to releaseVerifySlot). The daemon registers
    // process.pid as the alive-sentinel and a heartbeat interval to keep
    // lastActivityMs fresh. The watchdog uses case 2b (alive PID + fresh
    // heartbeat) and never ceiling-kills a live verify.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('remerge: full-suite verify', undefined, { skipTriage: true })

    // Task has been in 'verifying' for 35 minutes — past the 30-min default
    // ceiling. Without the fix, this would trigger case 2a and kill it.
    const stalledUpdatedAt = new Date(nowMs - 35 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying', updated_at = ? WHERE id = ?`,
      args: [stalledUpdatedAt, task.id],
    })

    const reclaimSlot = vi.fn()
    // In-flight entry: kind='implement' (the slot type), with alive PID and
    // fresh heartbeat (1 min ago). This is the state the fixed acquireVerifySlot
    // produces: it does NOT release the entry, sets pid=process.pid, and starts
    // a heartbeat. The test uses an arbitrary pid (12345) with a mocked isAlive.
    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 35 * 60_000,
        pid: 12345, // daemon's PID used as alive-sentinel
        lastActivityMs: nowMs - 1 * 60_000, // recent heartbeat
      },
    ]
    const isAlive = vi.fn().mockReturnValue(true) // daemon is alive → case 2b

    const { failed } = await watchdog.sweepPhantomTasks(
      inFlightEntries,
      reclaimSlot,
      isAlive,
      nowMs,
    )

    // Must NOT be failed: alive PID + fresh heartbeat overrides stale updatedAt
    // for a 'verifying' task (case 2b: NOT phantom).
    expect(failed).not.toContain(task.id)
    expect(reclaimSlot).not.toHaveBeenCalled()

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('verifying')

    // No action-queue item raised — the task is healthy.
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
  })

  it('does NOT fail a verifying task when dead in-flight PID but isVerifyRunning=true', async () => {
    // Regression test for the race between updateTask(status='verifying') and
    // acquireVerifySlot() recording process.pid as the alive-sentinel.
    //
    // The race window: the primitives call updateTask(status='verifying'), then
    // acquireVerifySlot(). Inside acquireVerifySlot, the daemon PID and
    // activeVerifyingTaskIds registration happen BEFORE the first async yield
    // (await acquire(verifySem)) — but if the verify semaphore has no free slot
    // the yield still occurs. If the watchdog sweeps at the exact moment between
    // updateTask resolving and acquireVerifySlot running synchronously (which
    // cannot happen in practice because they are sequenced as microtasks), or
    // more critically during the verifySem wait before the fix was applied
    // (where recordPid was called AFTER the await), the in-flight entry would
    // still carry the old code-phase worker PID — which has already exited
    // cleanly after coding finished.
    //
    // The watchdog must not fire 'dead-pid' when isVerifyRunning=true, even if
    // the in-flight PID is dead. This is the belt-and-suspenders guard added
    // to the watchdog to complement the primary fix in acquireVerifySlot.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('run full test suite', undefined, { skipTriage: true })

    // Task just entered 'verifying' (recent updatedAt — well within ceiling).
    const recentUpdatedAt = new Date(nowMs - 2 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying', updated_at = ? WHERE id = ?`,
      args: [recentUpdatedAt, task.id],
    })

    const reclaimSlot = vi.fn()
    // In-flight entry carries the dead code-phase worker PID.
    // This is the exact state during the race window.
    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 2 * 60_000,
        pid: 99999, // old worker PID — process has already exited cleanly
      },
    ]
    const isAlive = vi.fn().mockReturnValue(false) // worker subprocess is gone
    // isVerifyRunning=true — acquireVerifySlot registered this task before
    // the verify semaphore await.
    const isVerifyRunning = vi.fn().mockReturnValue(true)

    const { failed } = await watchdog.sweepPhantomTasks(
      inFlightEntries,
      reclaimSlot,
      isAlive,
      nowMs,
      undefined,
      isVerifyRunning,
    )

    // Must NOT be failed: isVerifyRunning=true is the definitive signal that
    // this daemon is actively running the verify — the dead PID is the old
    // code-phase worker, not the verify process.
    expect(failed).not.toContain(task.id)
    expect(reclaimSlot).not.toHaveBeenCalled()
    expect(isVerifyRunning).toHaveBeenCalledWith(task.id)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('verifying')

    // No action-queue item raised — the task is healthy.
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
  })

  it('keeps an alive worker running when it has not emitted events yet', async () => {
    // Providers can take several minutes to emit their first event. Process
    // liveness, not a silent event stream, is the required evidence for a
    // zero-event worker to be declared phantom.
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
        startedAt: nowMs - 35 * 60_000,
        pid: 12345,
        // No lastActivityMs — process has emitted zero events in 35 minutes.
      },
    ]
    const isAlive = vi.fn().mockReturnValue(true) // PID is alive but quiet
    const reclaimSlot = vi.fn()

    const { failed } = await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, isAlive, nowMs)

    expect(failed).not.toContain(task.id)
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('running')

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
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

// ── Merging task no-merge-job detection (no in-flight entry) ────────────────
//
// When a task is stuck in status='merging' but has no active merge_jobs row AND
// no in-flight entry (e.g. after a daemon restart where the startup reconcile
// failed to restore the job), the phantom watchdog should fail it immediately
// via the 'no-merge-job' reason — not wait for the 60-min merge ceiling.

describe('sweepPhantomTasks — merging/no-in-flight-entry/no-merge-job', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_PHANTOM_WATCHDOG_CEILING_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('immediately fails a merging task with no in-flight entry when there is no active merge job', async () => {
    /**
     * The exact bug shape from mars-0d6291da: a task entered status='merging'
     * but the merge job was lost (no active merge_jobs row). Without an
     * in-flight entry the old code fell back to the 60-min merge ceiling —
     * the task stayed stuck. With the fix, hasActiveMergeJob=false triggers
     * an immediate 'no-merge-job' fail, even for a recently-updated task.
     */
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('merge my feature branch', undefined, { skipTriage: true })

    // Age only 5 minutes — well within the 60-min merge ceiling.
    // Without the no-merge-job check, this task would NOT be detected.
    const recentUpdatedAt = new Date(nowMs - 5 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'merging', updated_at = ? WHERE id = ?`,
      args: [recentUpdatedAt, task.id],
    })

    const reclaimSlot = vi.fn()
    // Empty inFlight — no entry for this task in the current daemon (daemon restart).
    // hasActiveMergeJob returns false — no active merge_jobs row in the DB.
    const hasActiveMergeJob = vi.fn().mockResolvedValue(false)
    const { failed, requeued } = await watchdog.sweepPhantomTasks(
      [],
      reclaimSlot,
      undefined,
      nowMs,
      hasActiveMergeJob,
    )

    expect(failed).toContain(task.id)
    expect(requeued).not.toContain(task.id)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('merge')
    // The failure reason code must use the 'no-merge-job' phantom slug.
    expect(reloaded?.failureReasonCode).toBe('phantom-task:no-merge-job')

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe(watchdog.PHANTOM_TASK_KIND)
    expect(items[0].payload).toMatchObject({ reason: 'no-merge-job', taskId: task.id })

    // hasActiveMergeJob must have been called for this task's ID.
    expect(hasActiveMergeJob).toHaveBeenCalledWith(task.id)

    // reclaimSlot must NOT be called — no in-flight slot to reclaim.
    expect(reclaimSlot).not.toHaveBeenCalled()
  })

  it('does NOT fail a merging task with no in-flight entry when a merge job is active', async () => {
    /**
     * If a 'merging' task has no in-flight entry but DOES have an active
     * merge_jobs row, the merge worker is likely handling it — leave it alone.
     * The ceiling backstop will catch genuinely stuck tasks.
     */
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('merge active branch', undefined, { skipTriage: true })

    const recentUpdatedAt = new Date(nowMs - 5 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'merging', updated_at = ? WHERE id = ?`,
      args: [recentUpdatedAt, task.id],
    })

    const reclaimSlot = vi.fn()
    // hasActiveMergeJob returns true — the merge worker has a job to process.
    const hasActiveMergeJob = vi.fn().mockResolvedValue(true)
    const { failed } = await watchdog.sweepPhantomTasks(
      [],
      reclaimSlot,
      undefined,
      nowMs,
      hasActiveMergeJob,
    )

    expect(failed).not.toContain(task.id)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('merging')

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
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

// ── buildPhantomBody — plain-language human strings ──────────────────────────
//
// buildPhantomBody is a pure string function — no DB needed.
// Load modules once for the whole block to avoid exhausting the PGlite WASM
// instance limit that each loadModules() call incurs.

describe('buildPhantomBody — plain-language output', () => {
  let repo: string
  let watchdog: WatchdogModule

  beforeAll(async () => {
    repo = setupRepo()
    ;({ watchdog } = await loadModules(repo))
  })

  afterAll(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('uses the first line of prompt as the task goal (trimmed, ≤60 chars)', () => {
    const body = watchdog.buildPhantomBody(
      'mars-abc123',
      'running',
      'ceiling',
      33,
      'Add pagination to the user list endpoint\nSome extra context here.',
    )
    expect(body).toContain('Add pagination to the user list endpoint')
    expect(body).not.toContain('pinned to status')
    expect(body).not.toContain('in-flight slot')
    expect(body).not.toContain('subprocess PID')
    expect(body).not.toContain('phantom')
    expect(body).toContain('33 min')
    expect(body).toMatch(/[Rr]estart/)
    expect(body).toMatch(/drop/)
  })

  it('truncates a very long first line at 60 chars', () => {
    const longPrompt = 'A'.repeat(100)
    const body = watchdog.buildPhantomBody('mars-abc123', 'running', 'ceiling', 5, longPrompt)
    // The goal embedded in the body should be at most 60 chars
    const match = body.match(/"([^"]+)"/)
    expect(match).not.toBeNull()
    expect(match![1].length).toBeLessThanOrEqual(60)
  })

  it('falls back to task id in the goal when prompt is absent', () => {
    const body = watchdog.buildPhantomBody('mars-abc123', 'running', 'ceiling', 10)
    expect(body).toContain('mars-abc123')
    expect(body).not.toContain('pinned to status')
  })

  it('uses plain language for dead-pid reason', () => {
    const body = watchdog.buildPhantomBody('mars-abc123', 'running', 'dead-pid', 5, 'Fix auth bug')
    expect(body).toContain('Fix auth bug')
    expect(body).toContain('not alive when checked')
    expect(body).not.toContain('recorded subprocess PID')
  })

})

// ── action-queue title format ─────────────────────────────────────────────────

describe('sweepPhantomTasks — action-queue title format', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_PHANTOM_WATCHDOG_CEILING_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('title starts with "Stuck N min:" and includes a short task goal, not the task id', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask(
      'Migrate users table to new schema',
      undefined,
      { skipTriage: true },
    )

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()
    const inFlightEntries = [{ taskId: task.id, kind: 'implement' as const, startedAt: nowMs - 35 * 60_000 }]
    await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, undefined, nowMs)

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    const title = items[0].title
    // Must start with "Stuck N min:" pattern
    expect(title).toMatch(/^Stuck \d+ min:/)
    // Must include the task goal
    expect(title).toContain('Migrate users table to new schema')
    // Must NOT lead with the task id or the word "Phantom"
    expect(title).not.toMatch(/^Phantom/)
    expect(title).not.toMatch(new RegExp(`^${task.id}`))
  })

  it('falls back to task id in title when prompt is empty', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()
    const inFlightEntries = [{ taskId: task.id, kind: 'implement' as const, startedAt: nowMs - 35 * 60_000 }]
    await watchdog.sweepPhantomTasks(inFlightEntries, reclaimSlot, undefined, nowMs)

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].title).toMatch(/^Stuck \d+ min:/)
    expect(items[0].title).toContain(task.id)
  })
})

// ── 'merging' phantom detection (mars-0d6291da) ──────────────────────────────
//
// Tasks stuck in status='merging' must be detected and auto-failed by the
// phantom watchdog. Two scenarios are covered:
//  a. No in-flight entry (daemon restarted, orphaned task): fail after the
//     merge ceiling (resolvedMergeCeilingMs = 2 × DEFAULT_CEILING_MS by default).
//  b. In-flight entry with kind='merge' but no active merge_jobs row: fail
//     immediately when hasActiveMergeJob returns false.

describe('sweepPhantomTasks — merging phantom detection', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_PHANTOM_WATCHDOG_CEILING_MS
    delete process.env.MARS_MERGE_WATCHDOG_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('fails a merging task with no in-flight entry after the merge ceiling', async () => {
    // A 'merging' task with NO in-flight entry is orphaned from a prior daemon.
    // The phantom watchdog should fail it (not re-queue) after the merge ceiling.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('merge some work', undefined, { skipTriage: true })

    // Set the task to 'merging' status with updatedAt well past the merge ceiling.
    // The merge ceiling = 2 × DEFAULT_CEILING_MS (60 min default).
    // We use 61 minutes to be safely past it.
    const OLD_MERGE_UPDATED_AT = new Date(nowMs - 61 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'merging', updated_at = ? WHERE id = ?`,
      args: [OLD_MERGE_UPDATED_AT, task.id],
    })

    const reclaimSlot = vi.fn()
    // No in-flight entry — simulates daemon restart / orphaned task.
    const { failed, requeued } = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)

    expect(failed).toContain(task.id)
    expect(requeued).not.toContain(task.id)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('merge')
    expect(reloaded?.failureReasonCode).toBe('phantom-task:ceiling')

    // reclaimSlot must NOT be called — there is no in-flight slot to reclaim.
    expect(reclaimSlot).not.toHaveBeenCalled()

    // An action-queue item must have been raised for the operator.
    const items = await actionQueue.listActionQueueItems('open')
    const phantomItems = items.filter((i) => i.kind === watchdog.PHANTOM_TASK_KIND)
    expect(phantomItems).toHaveLength(1)
    expect(phantomItems[0].context).toEqual(expect.objectContaining({ taskId: task.id }))
  })

  it('does NOT fail a merging task with no in-flight entry within the merge ceiling', async () => {
    // A 'merging' task updated only 30 minutes ago is within the 60-min merge
    // ceiling and must be left alone.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('recent merge work', undefined, { skipTriage: true })

    const RECENT_UPDATED_AT = new Date(nowMs - 30 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'merging', updated_at = ? WHERE id = ?`,
      args: [RECENT_UPDATED_AT, task.id],
    })

    const reclaimSlot = vi.fn()
    const { failed } = await watchdog.sweepPhantomTasks([], reclaimSlot, undefined, nowMs)

    expect(failed).not.toContain(task.id)
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('merging')
    expect(reclaimSlot).not.toHaveBeenCalled()
    const items = await actionQueue.listActionQueueItems('open')
    expect(items.filter((i) => i.kind === watchdog.PHANTOM_TASK_KIND)).toHaveLength(0)
  })

  it('fails a merging task immediately when no active merge job exists (hasActiveMergeJob=false)', async () => {
    // A 'merging' task with an in-flight kind='merge' entry but no active
    // merge_jobs row should be failed immediately — the merge worker cannot
    // self-heal without a row to claim.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('lost merge job', undefined, { skipTriage: true })

    // Task just entered merging status (very recent updatedAt — within ceiling).
    const RECENT_UPDATED_AT = new Date(nowMs - 5 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'merging', updated_at = ? WHERE id = ?`,
      args: [RECENT_UPDATED_AT, task.id],
    })

    const reclaimSlot = vi.fn()
    // In-flight entry with kind='merge' — simulates daemon currently tracking it.
    const inFlightEntries = [{ taskId: task.id, kind: 'merge' as const, startedAt: nowMs - 5 * 60_000 }]
    // hasActiveMergeJob returns false — the merge_jobs row is missing.
    const hasActiveMergeJob = vi.fn().mockResolvedValue(false)

    const { failed } = await watchdog.sweepPhantomTasks(
      inFlightEntries,
      reclaimSlot,
      undefined,
      nowMs,
      hasActiveMergeJob,
    )

    expect(failed).toContain(task.id)
    expect(hasActiveMergeJob).toHaveBeenCalledWith(task.id)

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('merge')
    expect(reloaded?.failureReasonCode).toBe('phantom-task:no-merge-job')
    expect(reloaded?.error).toContain('no active merge_jobs row')

    // reclaimSlot must be called — the in-flight entry needs to be released.
    expect(reclaimSlot).toHaveBeenCalledWith(task.id, 'merge')

    const items = await actionQueue.listActionQueueItems('open')
    const phantomItems = items.filter((i) => i.kind === watchdog.PHANTOM_TASK_KIND)
    expect(phantomItems).toHaveLength(1)
    expect(phantomItems[0].payload).toMatchObject({ reason: 'no-merge-job' })
  })

  it('does NOT fail a merging task when it has an active merge job (within ceiling)', async () => {
    // A 'merging' task with in-flight entry AND active merge job is legitimately
    // in progress — the phantom watchdog must leave it alone.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('active merge', undefined, { skipTriage: true })

    const RECENT_UPDATED_AT = new Date(nowMs - 10 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'merging', updated_at = ? WHERE id = ?`,
      args: [RECENT_UPDATED_AT, task.id],
    })

    const reclaimSlot = vi.fn()
    const inFlightEntries = [{ taskId: task.id, kind: 'merge' as const, startedAt: nowMs - 10 * 60_000 }]
    // hasActiveMergeJob returns true — the merge worker is processing it.
    const hasActiveMergeJob = vi.fn().mockResolvedValue(true)

    const { failed } = await watchdog.sweepPhantomTasks(
      inFlightEntries,
      reclaimSlot,
      undefined,
      nowMs,
      hasActiveMergeJob,
    )

    expect(failed).not.toContain(task.id)
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('merging')
    expect(reclaimSlot).not.toHaveBeenCalled()
    expect(await actionQueue.listActionQueueItems('open')).toHaveLength(0)
  })

  it('fails a merging task with in-flight entry after the merge ceiling even with active job', async () => {
    // Even with an active merge job, a 'merging' task stuck for longer than
    // the merge ceiling must be failed — something is wrong with the merge worker.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('stale merge', undefined, { skipTriage: true })

    // 61 minutes ago — past the 60-min merge ceiling.
    const OLD_MERGE_UPDATED_AT = new Date(nowMs - 61 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'merging', updated_at = ? WHERE id = ?`,
      args: [OLD_MERGE_UPDATED_AT, task.id],
    })

    const reclaimSlot = vi.fn()
    const inFlightEntries = [{ taskId: task.id, kind: 'merge' as const, startedAt: nowMs - 61 * 60_000 }]
    // Even with a merge job, the ceiling fires.
    const hasActiveMergeJob = vi.fn().mockResolvedValue(true)

    const { failed } = await watchdog.sweepPhantomTasks(
      inFlightEntries,
      reclaimSlot,
      undefined,
      nowMs,
      hasActiveMergeJob,
    )

    expect(failed).toContain(task.id)
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('merge')
    expect(reloaded?.failureReasonCode).toBe('phantom-task:ceiling')
    expect(reclaimSlot).toHaveBeenCalledWith(task.id, 'merge')
  })
})

// ── Verify-semaphore queue: ceiling must not fire while waiting ───────────────
//
// Root cause of the verify/unclassified storm (mars-4892144d et al., caps.verify=1):
// acquireVerifySlot only started the heartbeat AFTER acquire(verifySem) returned.
// While queued behind a running verify, a task's in-flight entry had no PID and no
// heartbeat, so the watchdog used case 2a (stale updatedAt ceiling) and killed it.
//
// Fix: tracker.recordPid + heartbeat interval are started BEFORE await acquire(verifySem)
// (inside the verifyHandedOff guard), so the watchdog sees case 2b (alive PID +
// fresh heartbeat → never phantom) for the entire queue wait.

describe('sweepPhantomTasks — verify-semaphore queue ceiling immunity', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_PHANTOM_WATCHDOG_CEILING_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('does NOT ceiling-kill a verifying task queued on the semaphore for > ceiling (alive PID + fresh heartbeat)', async () => {
    // Reproduces the exact storm: caps.verify=1, five ui tasks all enter
    // status='verifying' and block on acquire(verifySem). Each waiting task
    // was >30 min old when the watchdog ran — ceiling-killed as verify/unclassified.
    //
    // After the fix, acquireVerifySlot records process.pid and starts the
    // heartbeat interval BEFORE await acquire(verifySem), so the in-flight
    // entry carries an alive PID + fresh heartbeat. The watchdog uses case 2b
    // (alive PID + fresh heartbeat → never phantom) and leaves the task alone.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('ui: render task list', undefined, { skipTriage: true })

    // Task has been in 'verifying' (and queued on the semaphore) for 35 minutes —
    // well past the 30-min ceiling. Before the fix this triggered a kill.
    const stalledUpdatedAt = new Date(nowMs - 35 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying', updated_at = ? WHERE id = ?`,
      args: [stalledUpdatedAt, task.id],
    })

    const reclaimSlot = vi.fn()
    // The fixed acquireVerifySlot sets pid=process.pid and starts the heartbeat
    // BEFORE the semaphore wait. Represented here as an alive PID + fresh heartbeat.
    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 35 * 60_000,
        pid: 12345,                        // daemon PID recorded before the wait
        lastActivityMs: nowMs - 1 * 60_000, // heartbeat kept fresh while queued
      },
    ]
    const isAlive = vi.fn().mockReturnValue(true) // daemon is alive → case 2b

    const { failed } = await watchdog.sweepPhantomTasks(
      inFlightEntries,
      reclaimSlot,
      isAlive,
      nowMs,
    )

    // Must NOT be killed: alive PID + fresh heartbeat overrides stale updatedAt.
    expect(failed).not.toContain(task.id)
    expect(reclaimSlot).not.toHaveBeenCalled()

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('verifying')

    // No action-queue item — the task is healthy and just waiting.
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
  })

  it('DOES ceiling-kill a verifying task with in-flight entry but no PID (genuinely dead, no pre-acquire setup)', async () => {
    // Dead-run detection must remain unchanged: when a task's in-flight entry
    // carries no PID (e.g. the daemon crashed before tracker.recordPid ran, or
    // the entry was created by a prior daemon that had not yet applied this fix),
    // the watchdog falls back to the bare updatedAt ceiling (case 2a) and kills it.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('ui: slow gate chain', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying', updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 35 * 60_000).toISOString(), task.id],
    })

    const reclaimSlot = vi.fn()
    // In-flight entry with NO pid and NO lastActivityMs: the pre-acquire setup
    // did not run (old daemon, crashed daemon, or other unexpected path).
    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 35 * 60_000,
        // no pid, no lastActivityMs
      },
    ]

    const { failed } = await watchdog.sweepPhantomTasks(
      inFlightEntries,
      reclaimSlot,
      undefined, // isAlive not called when no pid
      nowMs,
    )

    // Must be killed: no PID → case 2a (bare updatedAt ceiling) → ceiling exceeded.
    expect(failed).toContain(task.id)
    expect(reclaimSlot).toHaveBeenCalledWith(task.id, 'implement')

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('verify')

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe(watchdog.PHANTOM_TASK_KIND)
  })
})

// ── Hung verify runner: child died without runner exiting ─────────────────────
//
// Incident (2026-08-16 ~21:50-00:20): verify runner wedged 2.5h with ZERO
// vitest/npm/tsc processes. The heartbeat (commit 2ca0994d) used process.pid
// (daemon, always alive) so lastActivityMs stayed fresh indefinitely.
// activeVerifyingTaskIds added belt-and-suspenders immunity. Both together made
// hung verifies immortal.
//
// Fix: the heartbeat gates on real child liveness after the verify semaphore is
// acquired. When the verify child has been dead for >VERIFY_CHILD_GONE_GRACE_MS,
// the heartbeat stops — lastActivityMs goes stale — and the watchdog detects the
// task as runner-hung (alive PID + stale lastActivityMs + isVerifyRunning=true).
//
// Regression test: task in active verify (isVerifyRunning=true), alive daemon
// PID, but stale heartbeat (>30 min) → fails with verify:runner-hung.

describe('sweepPhantomTasks — hung verify runner (child died, heartbeat stopped)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_PHANTOM_WATCHDOG_CEILING_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('fails a verifying task as runner-hung when verify child is dead and heartbeat is stale', async () => {
    // Reproduces the hung-runner incident: verify slot was acquired, child
    // spawned and then died, but the runner never returned. The heartbeat
    // stopped updating lastActivityMs once the child was gone for >grace.
    // The watchdog must detect this as runner-hung — not generic ceiling.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('verify: run test suite', undefined, { skipTriage: true })

    // Task has been in 'verifying' for 35 minutes (past the 30-min ceiling).
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying', updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 35 * 60_000).toISOString(), task.id],
    })

    const reclaimSlot = vi.fn()
    // In-flight entry: daemon PID (alive) but stale lastActivityMs.
    // Simulates the state after the heartbeat stopped (verify child died,
    // grace window expired, heartbeat interval cleared itself).
    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 35 * 60_000,
        pid: process.pid,                    // daemon PID — always alive
        lastActivityMs: nowMs - 35 * 60_000, // stale: heartbeat stopped when child died
      },
    ]
    const isAlive = vi.fn().mockReturnValue(true) // daemon PID is alive
    // isVerifyRunning=true: the task acquired the verify slot (active verify phase,
    // not queued on the semaphore). The heartbeat stopped because the child died.
    const isVerifyRunning = vi.fn().mockReturnValue(true)

    const { failed } = await watchdog.sweepPhantomTasks(
      inFlightEntries,
      reclaimSlot,
      isAlive,
      nowMs,
      undefined, // hasActiveMergeJob not needed
      isVerifyRunning,
    )

    // Must be failed as runner-hung: alive daemon PID + stale heartbeat +
    // isVerifyRunning=true → runner held the slot after its child exited.
    expect(failed).toContain(task.id)
    expect(reclaimSlot).toHaveBeenCalledWith(task.id, 'implement')

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('verify')
    expect(reloaded?.failureReasonCode).toBe('phantom-task:runner-hung')

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe(watchdog.PHANTOM_TASK_KIND)
  })

  it('does NOT runner-hung-kill when isVerifyRunning is false (task still queued on semaphore)', async () => {
    // Regression: tasks queued behind a held verify slot have an alive daemon
    // PID + fresh heartbeat (fix from 2ca0994d). isVerifyRunning=false (they
    // haven't acquired the slot yet). Even with a stale heartbeat, if
    // isVerifyRunning=false the task must use the generic ceiling path, not
    // runner-hung. But here the heartbeat is fresh (queued tasks keep it alive),
    // so no kill at all.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('verify: heavy test suite', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'verifying', updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 35 * 60_000).toISOString(), task.id],
    })

    const reclaimSlot = vi.fn()
    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 35 * 60_000,
        pid: 12345,
        lastActivityMs: nowMs - 1 * 60_000, // fresh heartbeat: queued, not hung
      },
    ]
    const isAlive = vi.fn().mockReturnValue(true)
    const isVerifyRunning = vi.fn().mockReturnValue(false) // still queued, not active

    const { failed } = await watchdog.sweepPhantomTasks(
      inFlightEntries,
      reclaimSlot,
      isAlive,
      nowMs,
      undefined,
      isVerifyRunning,
    )

    // Must NOT be killed: fresh heartbeat overrides stale updatedAt.
    expect(failed).not.toContain(task.id)
    expect(reclaimSlot).not.toHaveBeenCalled()

    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('verifying')

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
  })

  it('uses generic ceiling (not runner-hung) for a non-verifying task with stale heartbeat and isVerifyRunning=false', async () => {
    // Belt-and-suspenders: if status='running' (not 'verifying') with stale
    // heartbeat, the watchdog must use 'ceiling', not 'runner-hung'. The
    // runner-hung path is verifying-only.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('implement: heavy feature', undefined, { skipTriage: true })

    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 35 * 60_000).toISOString(), task.id],
    })

    const reclaimSlot = vi.fn()
    const inFlightEntries = [
      {
        taskId: task.id,
        kind: 'implement' as const,
        startedAt: nowMs - 35 * 60_000,
        pid: process.pid,
        lastActivityMs: nowMs - 35 * 60_000, // stale heartbeat
      },
    ]
    const isAlive = vi.fn().mockReturnValue(true)
    // isVerifyRunning=true shouldn't matter for status='running'
    const isVerifyRunning = vi.fn().mockReturnValue(true)

    const { failed } = await watchdog.sweepPhantomTasks(
      inFlightEntries,
      reclaimSlot,
      isAlive,
      nowMs,
      undefined,
      isVerifyRunning,
    )

    // Must be failed — but as 'ceiling', not 'runner-hung'.
    expect(failed).toContain(task.id)
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReasonCode).toBe('phantom-task:ceiling')
  })
})

// ── Host-sleep detection ─────────────────────────────────────────────────────
//
// Root cause of the mars-f65bf202 incident: the machine slept 16.4 h between
// the setup step starting and the phantom-watchdog sweep firing on wake. The
// wall clock advanced by the full sleep duration; the monotonic clock
// (process.hrtime.bigint) did not. Every in-flight task appeared to have
// exceeded the 30-minute ceiling even though the workers had been idle for
// only seconds.
//
// Fix: sweepPhantomTasks accepts an optional SweepClock. When the wall-clock
// elapsed since the last sweep is significantly larger than the monotonic
// elapsed (divergence > SLEEP_SKIP_THRESHOLD_MS), the sweep is skipped and
// skippedSleepMs is returned. The next tick fires ~5 min later and evaluates
// tasks against accurate elapsed time.
//
// Two tests:
//   a. Sleep scenario (wall >> mono): task NOT auto-failed, skippedSleepMs set.
//   b. Genuine stall (wall ≈ mono, task old): task IS auto-failed as normal.

describe('sweepPhantomTasks — host-sleep detection', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_PHANTOM_WATCHDOG_CEILING_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('skips sweep entirely and returns skippedSleepMs when monotonic delta reveals host slept', async () => {
    // Reproduces the mars-f65bf202 incident: the setup step completed, the
    // machine slept 16.4 h, the phantom watchdog fired on wake. The task's
    // updatedAt was 16h+ old — well past the 30-min ceiling — but the actual
    // monotonic time elapsed since the last sweep was only ~5 minutes (the
    // setInterval fired almost immediately on wake after the pre-sleep tick).
    //
    // The watchdog must detect the divergence and skip the sweep pass instead
    // of auto-failing the task.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('long-running setup', undefined, { skipTriage: true })

    // Task's updatedAt reflects the pre-sleep start: ~16 h ago in wall-clock.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 16 * 60 * 60_000).toISOString(), task.id],
    })

    const reclaimSlot = vi.fn()
    const inFlightEntries = [
      { taskId: task.id, kind: 'implement' as const, startedAt: nowMs - 16 * 60 * 60_000 },
    ]

    // SweepClock: wall-clock elapsed = 16 h, monotonic elapsed = 5 min.
    // The large divergence (16 h - 5 min ≈ 16 h) exceeds SLEEP_SKIP_THRESHOLD_MS.
    const sweepClock = {
      prevWallMs: nowMs - 16 * 60 * 60_000,
      prevMonoMs: 1_000,
      nowMonoMs: 1_000 + 5 * 60_000,
    }

    const result = await watchdog.sweepPhantomTasks(
      inFlightEntries,
      reclaimSlot,
      undefined,
      nowMs,
      undefined,
      undefined,
      sweepClock,
    )

    // Sweep was skipped: no tasks touched, slept duration reported back.
    expect(result.failed).toHaveLength(0)
    expect(result.requeued).toHaveLength(0)
    expect(result.skippedSleepMs).toBeGreaterThan(0)

    // Task must remain 'running' — the watchdog did nothing.
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('running')

    // No action-queue item raised.
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)

    // reclaimSlot was never called.
    expect(reclaimSlot).not.toHaveBeenCalled()
  })

  it('still auto-fails a genuinely stalled task when both clocks agree (no sleep)', async () => {
    // Companion test: when wall-clock and monotonic elapsed are close (the
    // machine was not sleeping), the task's updatedAt age is the authoritative
    // signal and the ceiling must still fire normally.
    const { q, watchdog } = await loadModules(repo)
    const nowMs = Date.now()
    const task = await q.enqueueTask('stalled work', undefined, { skipTriage: true })

    // 31 minutes old — past the 30-min default ceiling.
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      args: [OLD_UPDATED_AT(nowMs), task.id],
    })

    const reclaimSlot = vi.fn()
    const inFlightEntries = [
      { taskId: task.id, kind: 'implement' as const, startedAt: nowMs - 35 * 60_000 },
    ]

    // SweepClock: both wall-clock and monotonic elapsed ≈ 5 min (normal tick).
    // Divergence = 0 → no sleep detected → sweep proceeds as normal.
    const sweepClock = {
      prevWallMs: nowMs - 5 * 60_000,
      prevMonoMs: 1_000,
      nowMonoMs: 1_000 + 5 * 60_000,
    }

    const { failed, skippedSleepMs } = await watchdog.sweepPhantomTasks(
      inFlightEntries,
      reclaimSlot,
      undefined,
      nowMs,
      undefined,
      undefined,
      sweepClock,
    )

    // No sleep detected.
    expect(skippedSleepMs).toBeUndefined()

    // Task must be failed: ceiling exceeded, in-flight entry present.
    expect(failed).toContain(task.id)
    const reloaded = await q.getTask(task.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failedPhase).toBe('code')
    expect(reclaimSlot).toHaveBeenCalledWith(task.id, 'implement')
  })
})
