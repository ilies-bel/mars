/**
 * Tests for GET /view/counts — the unified counts endpoint.
 *
 * Verifies:
 *   - HTTP 200 and that viewCounts is called
 *   - Response shape matches the seeded values exactly
 *   - proposals.draft and proposals.total are forwarded
 *   - needsYou is forwarded from viewCounts
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import type { TraceEventStore } from '../../lib/trace-events-store'
import type { Counts } from '../view/counts'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

beforeAll(async () => {
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-counts-view-cat-'))
  cachedRecipeCatalog = await loadRecipeCatalog(tmpDir)
})

const stubTraceStore: TraceEventStore = {
  record: async () => {},
  query: async () => [],
  close: async () => {},
}

const makeDeps = (
  appServicesOverrides: Partial<AppServices> = {},
): HttpServerDeps => ({
  restartTask: async () => {},
  continueTask: async () => {},
  remergeTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => ({ taskIds: [] }),
  validateTask: async () => {},
  rejectTask: async () => {},
  landWork: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }),
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},
  runReflect: async () => ({ proposalsRaised: 0 }),
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: stubTraceStore,
  appServices: stubAppServices(appServicesOverrides),
  chatRunner: stubChatRunner(),
})

// ── GET /view/counts ──────────────────────────────────────────────────────────

describe('GET /view/counts', () => {
  it('returns 200 and invokes viewCounts', async () => {
    let called = false
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewCounts: async () => {
          called = true
          return {
            needsYou: 0, running: 0, verifying: 0, merging: 0,
            queued: 0, blocked: 0, failed: 0, doneToday: 0,
            proposals: { draft: 0, total: 0 },
          }
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/counts`)
      expect(res.status).toBe(200)
      expect(called).toBe(true)
    } finally {
      await close()
    }
  })

  it('returns counts matching a seeded task set', async () => {
    const seeded: Counts = {
      needsYou: 3,
      running: 5,
      verifying: 2,
      merging: 1,
      queued: 7,
      blocked: 4,
      failed: 2,
      doneToday: 10,
      proposals: { draft: 6, total: 14 },
    }

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewCounts: async () => seeded }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/counts`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as unknown
      expect(body).toEqual(seeded)
    } finally {
      await close()
    }
  })

  it('forwards needsYou correctly', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewCounts: async () => ({
          needsYou: 7, running: 0, verifying: 0, merging: 0,
          queued: 0, blocked: 0, failed: 0, doneToday: 0,
          proposals: { draft: 0, total: 0 },
        }),
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/counts`)
      const body = (await res.json()) as { needsYou: number }
      expect(body.needsYou).toBe(7)
    } finally {
      await close()
    }
  })

  it('forwards proposals.draft and proposals.total', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewCounts: async () => ({
          needsYou: 0, running: 0, verifying: 0, merging: 0,
          queued: 0, blocked: 0, failed: 0, doneToday: 0,
          proposals: { draft: 11, total: 23 },
        }),
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/counts`)
      const body = (await res.json()) as { proposals: { draft: number; total: number } }
      expect(body.proposals.draft).toBe(11)
      expect(body.proposals.total).toBe(23)
    } finally {
      await close()
    }
  })
})
