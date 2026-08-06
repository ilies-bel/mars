/**
 * Tests for GET /view/primitives and GET /view/primitives/:name — the
 * daemon-side primitive-facet endpoints.
 *
 * Covers:
 *   - 200 list forwarded verbatim from viewPrimitives
 *   - 200 detail forwarded verbatim from viewPrimitive (name + limit decoded)
 *   - 404 when viewPrimitive resolves null (unknown primitive)
 *   - 400 on a non-positive / non-integer limit
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps, PrimitiveDetail, PrimitiveSummary } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import type { TraceEventStore } from '../../lib/trace-events-store'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

beforeAll(async () => {
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-http-primitives-cat-'))
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
  remergeTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => {},
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
  enableAutoReflect: async () => {},
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: cachedRecipeCatalog as Awaited<
    ReturnType<typeof loadRecipeCatalog>
  >,
  traceStore: stubTraceStore,
  appServices: stubAppServices(appServicesOverrides),
  chatRunner: stubChatRunner(),
})

const summary: PrimitiveSummary = {
  name: 'verify',
  description: 'Scope-aware static gate.',
  phase: 'verify',
  executor: 'shell',
}

const detail: PrimitiveDetail = {
  primitive: summary,
  workers: [],
  observedTools: [{ tool: 'git', count: 3, lastInvokedAt: '2025-01-01T10:00:00.000Z' }],
  caveats: [],
  runs: [],
  parks: [],
  window: 50,
}

describe('GET /view/primitives', () => {
  it('returns 200 and forwards the catalog list verbatim', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewPrimitives: async () => ({ primitives: [summary] }) }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/primitives`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ primitives: [summary] })
    } finally {
      await close()
    }
  })
})

describe('GET /view/primitives/:name', () => {
  it('returns 200 and forwards the detail, decoding name and limit', async () => {
    let received: { name: string; limit?: number } | null = null
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewPrimitive: async (params) => {
          received = params
          return detail
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/primitives/verify?limit=25`,
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(detail)
      expect(received).toEqual({ name: 'verify', limit: 25 })
    } finally {
      await close()
    }
  })

  it('returns 404 when the primitive is unknown', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewPrimitive: async () => null }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/primitives/nope`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/nope/)
    } finally {
      await close()
    }
  })

  it('returns 400 on a non-positive limit', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/primitives/verify?limit=0`,
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/limit/)
    } finally {
      await close()
    }
  })
})
