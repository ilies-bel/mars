import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  initQueue: typeof import('../../queue').initQueue
}

interface InboxModule {
  listInboxItems: typeof import('../../lib/inbox').listInboxItems
  getInboxItem: typeof import('../../lib/inbox').getInboxItem
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
): Promise<{ q: QueueModule; inbox: InboxModule; watchdog: WatchdogModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const inbox = (await import('../../lib/inbox')) as unknown as InboxModule
  const watchdog = (await import('../observability-watchdog')) as unknown as WatchdogModule
  return { q, inbox, watchdog }
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

  it('raises an inbox item when the store exceeds 500 MB', async () => {
    const { inbox, watchdog } = await loadModules(repo)
    const OVERSIZE = watchdog.OVERSIZE_THRESHOLD_BYTES + 1

    const itemId = await watchdog.checkObservabilityStoreSize(
      '/fake/observability.duckdb',
      async () => OVERSIZE,
    )

    expect(itemId).toBeTruthy()
    const items = await inbox.listInboxItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe(watchdog.OBSERVABILITY_WATCHDOG_KIND)
  })

  it('raises no inbox item when the store is under the 500 MB threshold', async () => {
    const { inbox, watchdog } = await loadModules(repo)

    const itemId = await watchdog.checkObservabilityStoreSize(
      '/fake/observability.duckdb',
      async () => watchdog.OVERSIZE_THRESHOLD_BYTES - 1,
    )

    expect(itemId).toBeNull()
    const items = await inbox.listInboxItems('open')
    expect(items).toHaveLength(0)
  })

  it('repeated oversize checks update the existing item rather than creating duplicates', async () => {
    const { inbox, watchdog } = await loadModules(repo)
    const OVERSIZE = watchdog.OVERSIZE_THRESHOLD_BYTES + 1
    const measure = async (): Promise<number> => OVERSIZE

    const firstId = await watchdog.checkObservabilityStoreSize(
      '/fake/observability.duckdb',
      measure,
    )
    const secondId = await watchdog.checkObservabilityStoreSize(
      '/fake/observability.duckdb',
      measure,
    )

    // Same item id returned on every oversize detection
    expect(firstId).toBe(secondId)

    // Still exactly one open item — no sibling was created
    const items = await inbox.listInboxItems('open')
    expect(items).toHaveLength(1)

    // seen_count was bumped on the second detection
    const item = await inbox.getInboxItem(firstId!)
    expect(item!.seenCount).toBe(2)
  })

  it('the raised inbox item describes the oversize condition and current size', async () => {
    const { inbox, watchdog } = await loadModules(repo)
    const SIZE_BYTES = 600 * 1024 * 1024 // 600 MB

    await watchdog.checkObservabilityStoreSize(
      '/fake/observability.duckdb',
      async () => SIZE_BYTES,
    )

    const items = await inbox.listInboxItems('open')
    expect(items).toHaveLength(1)
    expect(items[0].body).toContain('600.0 MB')
    expect(items[0].body).toContain('500 MB')
    expect(items[0].payload).toMatchObject({ sizeBytes: SIZE_BYTES })
  })

  it('the watchdog never prunes the store or alters retention when oversize', async () => {
    const { inbox, watchdog } = await loadModules(repo)
    // 550 MB oversize
    const SIZE_BYTES = 550 * 1024 * 1024

    const itemId = await watchdog.checkObservabilityStoreSize(
      '/fake/observability.duckdb',
      async () => SIZE_BYTES,
    )

    // An inbox item was raised — the oversize condition is visible to the operator
    expect(itemId).toBeTruthy()

    // The payload records the size but contains no pruning or retention metadata
    const item = await inbox.getInboxItem(itemId!)
    expect(item!.payload).not.toHaveProperty('pruned')
    expect(item!.payload).not.toHaveProperty('retentionChangedTo')
    expect(item!.payload).not.toHaveProperty('prunedBytes')
  })
})
