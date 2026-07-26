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
      queueDepth: 1,
      dispatchDecisionSummary: [],
      nowMs,
    })

    // Second sweep — bumps seen_count, does NOT create a sibling row
    const { alerted } = await watchdog.runStaleQueuedSweep({
      activeWorkerCount: 1,
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
      queueDepth: 1,
      dispatchDecisionSummary: [],
      nowMs,
    })

    expect(alerted).toContain(task.id)
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
  })
})
