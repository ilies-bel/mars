import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
}

interface WatchdogModule {
  checkObservabilityStoreSize: typeof import('../observability-watchdog').checkObservabilityStoreSize
  buildOversizeBody: typeof import('../observability-watchdog').buildOversizeBody
  OBSERVABILITY_WATCHDOG_KIND: typeof import('../observability-watchdog').OBSERVABILITY_WATCHDOG_KIND
  OVERSIZE_THRESHOLD_BYTES: typeof import('../observability-watchdog').OVERSIZE_THRESHOLD_BYTES
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-obs-watchdog-'))
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
  const watchdog = (await import('../observability-watchdog')) as unknown as WatchdogModule
  return { q, actionQueue, watchdog }
}

describe('checkObservabilityStoreSize', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises an action-queue item when the store exceeds 500 MB', async () => {
    const { actionQueue, watchdog } = await loadModules(repo)
    const OVERSIZE = watchdog.OVERSIZE_THRESHOLD_BYTES + 1

    const itemId = await watchdog.checkObservabilityStoreSize(
      '/fake/mars.db',
      async () => OVERSIZE,
    )

    expect(itemId).toBeTruthy()
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe(watchdog.OBSERVABILITY_WATCHDOG_KIND)
  })

  it('raises no action-queue item when the store is under the 500 MB threshold', async () => {
    const { actionQueue, watchdog } = await loadModules(repo)

    const itemId = await watchdog.checkObservabilityStoreSize(
      '/fake/mars.db',
      async () => watchdog.OVERSIZE_THRESHOLD_BYTES - 1,
    )

    expect(itemId).toBeNull()
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(0)
  })

  it('repeated oversize checks update the existing item rather than creating duplicates', async () => {
    const { actionQueue, watchdog } = await loadModules(repo)
    const OVERSIZE = watchdog.OVERSIZE_THRESHOLD_BYTES + 1
    const measure = async (): Promise<number> => OVERSIZE

    const firstId = await watchdog.checkObservabilityStoreSize(
      '/fake/mars.db',
      measure,
    )
    const secondId = await watchdog.checkObservabilityStoreSize(
      '/fake/mars.db',
      measure,
    )

    // Same item id returned on every oversize detection
    expect(firstId).toBe(secondId)

    // Still exactly one open item — no sibling was created
    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)

    // seen_count was bumped on the second detection
    const item = await actionQueue.getActionQueueItem(firstId!)
    expect(item!.seenCount).toBe(2)
  })

  it('the raised action-queue item describes the oversize condition and current size', async () => {
    const { actionQueue, watchdog } = await loadModules(repo)
    const SIZE_BYTES = 600 * 1024 * 1024 // 600 MB

    await watchdog.checkObservabilityStoreSize(
      '/fake/mars.db',
      async () => SIZE_BYTES,
    )

    const items = await actionQueue.listActionQueueItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].body).toContain('600.0 MB')
    expect(items[0].body).toContain('500 MB')
    expect(items[0].payload).toMatchObject({ sizeBytes: SIZE_BYTES })
  })

  it('the watchdog never prunes the store or alters retention when oversize', async () => {
    const { actionQueue, watchdog } = await loadModules(repo)
    // 550 MB oversize
    const SIZE_BYTES = 550 * 1024 * 1024

    const itemId = await watchdog.checkObservabilityStoreSize(
      '/fake/mars.db',
      async () => SIZE_BYTES,
    )

    // An action-queue item was raised — the oversize condition is visible to the operator
    expect(itemId).toBeTruthy()

    // The payload records the size but contains no pruning or retention metadata
    const item = await actionQueue.getActionQueueItem(itemId!)
    expect(item!.payload).not.toHaveProperty('pruned')
    expect(item!.payload).not.toHaveProperty('retentionChangedTo')
    expect(item!.payload).not.toHaveProperty('prunedBytes')
  })

  it('measures trace_events size via real SQLite dbstat query — returns null for an empty db', async () => {
    // Real-boundary test: exercises the actual measureStoreSizeBytes implementation
    // against a real SQLite database (no injected stub). Confirms the dbstat query
    // runs without error and correctly reports a tiny/empty table as under the threshold.
    const { watchdog } = await loadModules(repo)
    const stateDb = resolve(repo, '.mars', 'mars.db')

    // migrateQueueSchema (called inside loadModules) creates trace_events via
    // migrateSignalsAndTranscriptsToTraceEvents. The table exists but is empty,
    // so dbstat reports 0 bytes — well under the 500 MB threshold.
    const itemId = await watchdog.checkObservabilityStoreSize(stateDb)
    expect(itemId).toBeNull()
  })
})
