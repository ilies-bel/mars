import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
}

interface WatchdogModule {
  runStaleQueuedSweep: typeof import('../stale-queued-watchdog').runStaleQueuedSweep
  STALE_QUEUED_KIND: typeof import('../stale-queued-watchdog').STALE_QUEUED_KIND
  STALE_QUEUED_SUMMARY_KIND: typeof import('../stale-queued-watchdog').STALE_QUEUED_SUMMARY_KIND
  DEFAULT_STALE_QUEUED_MS: typeof import('../stale-queued-watchdog').DEFAULT_STALE_QUEUED_MS
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-stale-queued-watchdog-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; actionQueue: ActionQueueModule; watchdog: WatchdogModule }> => {
  const { vi } = await import('vitest')
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const watchdog = (await import('../stale-queued-watchdog')) as unknown as WatchdogModule
  return { q, actionQueue, watchdog }
}

describe('runStaleQueuedSweep', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_STALE_QUEUED_MS
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises exactly one alert for the stale task and none for the fresh task', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    // Seed one fresh queued task (updated_at = now — well within threshold)
    const freshTask = await q.enqueueTask('fresh work', undefined, { skipTriage: true })

    // Seed one stale queued task (updated_at = 11 minutes ago — past the default 10-min threshold)
    const staleTask = await q.enqueueTask('stale work', undefined, { skipTriage: true })
    const staleUpdatedAt = new Date(nowMs - 11 * 60_000).toISOString()
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [staleUpdatedAt, staleTask.id],
    })

    // Run the watchdog once
    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 2,
      dispatchDecisionSummary: [],
      nowMs,
    })

    // Exactly one alert — for the stale task
    expect(alerted).toHaveLength(1)
    expect(alerted[0]).toBe(staleTask.id)
    expect(alerted).not.toContain(freshTask.id)

    // Verify the action-queue row
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe(watchdog.STALE_QUEUED_KIND)
    expect(items[0].payload).toMatchObject({
      taskId: staleTask.id,
      activeWorkerCount: 0,
      queueDepth: 2,
    })
    expect(typeof (items[0].payload as Record<string, unknown>).queuedAgeMs).toBe('number')
  })

  it('suppresses duplicate alerts for the same stale task on a second sweep', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    const staleTask = await q.enqueueTask('stale work', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 15 * 60_000).toISOString(), staleTask.id],
    })

    // First sweep — creates the alert
    await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 1,
      implementCap: 2,
      queueDepth: 1,
      dispatchDecisionSummary: [],
      nowMs,
    })

    // Second sweep — bumps seen_count, does NOT create a sibling row
    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 1,
      implementCap: 2,
      queueDepth: 1,
      dispatchDecisionSummary: [],
      nowMs: nowMs + 5 * 60_000,
    })

    expect(alerted).toContain(staleTask.id)

    const items = await actionQueue.listActionQueueItems('open')
    // Still exactly one row (seen_count bumped, not a new sibling)
    expect(items).toHaveLength(1)
    expect(items[0].seenCount).toBe(2)
  })

  it('raises no alert when all queued tasks are within the threshold', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    // Two fresh tasks — both within the default 10-min threshold
    await q.enqueueTask('fresh work A', undefined, { skipTriage: true })
    await q.enqueueTask('fresh work B', undefined, { skipTriage: true })

    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 2,
      implementCap: 2,
      queueDepth: 2,
      dispatchDecisionSummary: [],
      nowMs,
    })

    expect(alerted).toHaveLength(0)
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
  })

  it('respects MARS_STALE_QUEUED_MS env override', async () => {
    // Set threshold to 30 seconds so a 1-minute-old task is stale
    process.env.MARS_STALE_QUEUED_MS = String(30_000)

    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    const task = await q.enqueueTask('slightly old work', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 60_000).toISOString(), task.id],
    })

    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 1,
      dispatchDecisionSummary: [],
      nowMs,
    })

    expect(alerted).toContain(task.id)
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
  })

  it('does not alert for aged tasks while every implement slot is occupied', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    const task = await q.enqueueTask('waiting behind a full pool', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 30 * 60_000).toISOString(), task.id],
    })

    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 2,
      implementCap: 2,
      queueDepth: 1,
      dispatchDecisionSummary: [],
      nowMs,
    })

    expect(alerted).toEqual([])
    expect(await actionQueue.listActionQueueItems('open')).toHaveLength(0)
  })

  it('raises only the oldest stale-task alerts and a visible suppression summary', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    for (let index = 0; index < 25; index += 1) {
      const task = await q.enqueueTask(`stale work ${index}`, undefined, { skipTriage: true })
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
        args: [new Date(nowMs - (index + 11) * 60_000).toISOString(), task.id],
      })
    }

    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 25,
      dispatchDecisionSummary: [],
      nowMs,
    })

    expect(alerted).toHaveLength(20)
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(21)
    const summary = items.find(
      (item) => (item.payload as Record<string, unknown>).suppressionSummary === true,
    )
    expect(summary?.kind).toBe(watchdog.STALE_QUEUED_SUMMARY_KIND)
    expect(summary?.body).toContain('5 additional stale queued task alert(s)')
  })

  it('raises no stale-queued alert while dispatch is paused (operator)', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    // A task that is well past the threshold
    const staleTask = await q.enqueueTask('stale work', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 30 * 60_000).toISOString(), staleTask.id],
    })

    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 1,
      dispatchDecisionSummary: [],
      dispatchPauseState: {
        paused: true,
        reason: 'operator',
        since: new Date(nowMs - 30 * 60_000).toISOString(),
        detail: null,
      },
      nowMs,
    })

    // Dispatch is deliberately paused — no alert should be raised
    expect(alerted).toHaveLength(0)
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
  })

  it('raises no stale-queued alert while dispatch is paused (storm)', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    const staleTask = await q.enqueueTask('stale work', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 20 * 60_000).toISOString(), staleTask.id],
    })

    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 1,
      dispatchDecisionSummary: [],
      dispatchPauseState: {
        paused: true,
        reason: 'storm',
        since: new Date(nowMs - 20 * 60_000).toISOString(),
        detail: 'signature storm detected',
      },
      nowMs,
    })

    expect(alerted).toHaveLength(0)
    expect(await actionQueue.listActionQueueItems('open')).toHaveLength(0)
  })

  it('still raises a stale-queued alert when dispatch is running and a task is genuinely stuck', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    const staleTask = await q.enqueueTask('stuck work', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 15 * 60_000).toISOString(), staleTask.id],
    })

    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 1,
      dispatchDecisionSummary: [],
      // dispatch is running (no pause state)
      nowMs,
    })

    expect(alerted).toHaveLength(1)
    expect(alerted[0]).toBe(staleTask.id)
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe(watchdog.STALE_QUEUED_KIND)
  })

  it('restarts the staleness clock on dispatch resume — does not immediately alert for parked time', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    // Task was queued 20 min ago (well past the default 10-min threshold by raw age)
    const task = await q.enqueueTask('parked work', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 20 * 60_000).toISOString(), task.id],
    })

    // Dispatch resumed only 5 min ago — the task should not yet be considered stale,
    // because the staleness clock starts from the resume time
    const dispatchResumedAt = nowMs - 5 * 60_000

    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 1,
      dispatchDecisionSummary: [],
      dispatchPauseState: { paused: false, reason: null, since: null, detail: null },
      dispatchResumedAt,
      nowMs,
    })

    // 5 min since resume < 10 min threshold → no alert yet
    expect(alerted).toHaveLength(0)
    expect(await actionQueue.listActionQueueItems('open')).toHaveLength(0)
  })

  it('alerts after the threshold elapses following a dispatch resume', async () => {
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    // Task queued 30 min ago
    const task = await q.enqueueTask('parked work', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 30 * 60_000).toISOString(), task.id],
    })

    // Dispatch resumed 11 min ago — past the 10 min threshold since resume
    const dispatchResumedAt = nowMs - 11 * 60_000

    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 1,
      dispatchDecisionSummary: [],
      dispatchPauseState: { paused: false, reason: null, since: null, detail: null },
      dispatchResumedAt,
      nowMs,
    })

    // 11 min since resume > 10 min threshold → alert fires
    expect(alerted).toHaveLength(1)
    expect(alerted[0]).toBe(task.id)
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe(watchdog.STALE_QUEUED_KIND)
  })

  // ── Regression: phantom stale-queued rows for non-queued tasks ──────────────
  // Bug: stale-queued rows raised while a task was queued persisted even after
  // the task transitioned to failed/done/running. The alert-dismisser
  // correctly issues a NO-OP on task.failed (ADR-0028), so the stale-queued
  // row was never closed. The sweep now reconciles open stale-queued rows
  // against the live queued-task set on every run.

  it('emits no stale-queued rows for tasks already in failed or done status', async () => {
    // Regression guard: the sweep must filter by live status, not by age alone.
    // Tasks that were never queued (or already left queued) must not generate alerts.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    // Seed a task directly in 'failed' status with age > threshold.
    const task = await q.enqueueTask('already failed work', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 30 * 60_000).toISOString(), task.id],
    })

    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 0,
      dispatchDecisionSummary: [],
      nowMs,
    })

    expect(alerted).toHaveLength(0)
    const items = await actionQueue.listActionQueueItems('open')
    expect(items.filter((i) => i.kind === watchdog.STALE_QUEUED_KIND)).toHaveLength(0)
    expect(items.filter((i) => i.kind === watchdog.STALE_QUEUED_SUMMARY_KIND)).toHaveLength(0)
  })

  it('closes a stale-queued alert on the next sweep after the task transitions to failed', async () => {
    // Regression: stale-queued rows were never closed when a task failed.
    // The alert-dismisser NO-OPs on task.failed (ADR-0028), so the sweep
    // itself must reconcile open rows against the live queued-task set.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    // Seed a stale queued task
    const task = await q.enqueueTask('stale then failed', undefined, { skipTriage: true })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
      args: [new Date(nowMs - 15 * 60_000).toISOString(), task.id],
    })

    // First sweep: task is queued and stale → alert raised
    await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 1,
      dispatchDecisionSummary: [],
      nowMs,
    })

    const before = await actionQueue.listActionQueueItems('open')
    expect(before.filter((i) => i.kind === watchdog.STALE_QUEUED_KIND)).toHaveLength(1)

    // Task transitions to failed (the alert-dismisser issues a NO-OP for task.failed)
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [task.id],
    })

    // Second sweep: task is no longer queued → reconciler closes the stale-queued row
    await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 0,
      dispatchDecisionSummary: [],
      nowMs: nowMs + 5 * 60_000,
    })

    const after = await actionQueue.listActionQueueItems('open')
    expect(after.filter((i) => i.kind === watchdog.STALE_QUEUED_KIND)).toHaveLength(0)
  })

  it('closes the stale-queued-summary on the next sweep after all suppressed tasks drain', async () => {
    // Regression: the summary row was never closed when the stale-queued backlog
    // drained. Once suppressedCount drops to 0 the sweep must close any open summary.
    const { q, actionQueue, watchdog } = await loadModules(repo)
    const nowMs = Date.now()

    // Create 25 stale queued tasks — enough to overflow into a summary row
    const taskIds: string[] = []
    for (let index = 0; index < 25; index += 1) {
      const task = await q.enqueueTask(`stale task ${index}`, undefined, { skipTriage: true })
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET updated_at = ? WHERE id = ?`,
        args: [new Date(nowMs - (index + 11) * 60_000).toISOString(), task.id],
      })
      taskIds.push(task.id)
    }

    // First sweep: raises 20 individual alerts + 1 summary for the 5 suppressed ones
    await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 25,
      dispatchDecisionSummary: [],
      nowMs,
    })

    const before = await actionQueue.listActionQueueItems('open')
    expect(before.filter((i) => i.kind === watchdog.STALE_QUEUED_SUMMARY_KIND)).toHaveLength(1)

    // All tasks transition to failed
    for (const taskId of taskIds) {
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
        args: [taskId],
      })
    }

    // Second sweep: no queued tasks remain →
    // reconciler closes individual rows, summary row is also closed
    await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 0,
      dispatchDecisionSummary: [],
      nowMs: nowMs + 5 * 60_000,
    })

    const after = await actionQueue.listActionQueueItems('open')
    expect(after.filter((i) => i.kind === watchdog.STALE_QUEUED_KIND)).toHaveLength(0)
    expect(after.filter((i) => i.kind === watchdog.STALE_QUEUED_SUMMARY_KIND)).toHaveLength(0)
  })
})
