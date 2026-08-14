/**
 * HTTP test for GET /kpi/cost-per-merged-task.
 *
 * Verifies that the daemon's route:
 *   - accepts ?days=<n> (defaults to 30 when absent)
 *   - delegates to the injected getCostPerMergedTaskKpi dep
 *   - returns 200 with the expected JSON shape
 *
 * The database interaction is tested separately in the unit tests at
 * src/core/lib/kpi/cost-per-merged-task.test.ts. This test focuses on
 * route wiring, parameter parsing, and response shape.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../../http-server.js'
import { stubAppServices, stubChatRunner } from '../../__tests__/app-services-stub.js'
import { loadRecipeCatalog } from '../../../lib/recipes.js'
import { nullTraceStore } from '../../../lib/run-tool.js'
import type { CostPerMergedTaskKpi } from '../../../lib/kpi/cost-per-merged-task.js'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-kpi-cost-rec-')),
  )
})

const EMPTY_KPI: CostPerMergedTaskKpi = {
  current: {
    costUsd: null,
    tokens: 0,
    mergedCount: 0,
    avgCostPerMerge: null,
    excludedNullCostCount: 0,
  },
  trend: [],
}

const SAMPLE_KPI: CostPerMergedTaskKpi = {
  current: {
    costUsd: 4.5,
    tokens: 1500,
    mergedCount: 3,
    avgCostPerMerge: 1.5,
    excludedNullCostCount: 0,
  },
  trend: [
    { day: '2026-01-10', avgCostPerMerge: 1.5, mergedCount: 3 },
  ],
}

const makeDeps = (
  getCostPerMergedTaskKpi?: (opts: { windowDays: number }) => Promise<CostPerMergedTaskKpi>,
  overrides: Partial<HttpServerDeps> = {},
): HttpServerDeps => ({
  restartTask: async () => {},
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
  enableAutoReflect: async () => {},
  disableAutoReflect: async () => {},
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  getCostPerMergedTaskKpi,
  ...overrides,
})

describe('GET /kpi/cost-per-merged-task', () => {
  it('returns 200 with the KPI shape when dep is injected', async () => {
    const { startHttpServer } = await import('../../http-server.js')
    const { port, close } = await startHttpServer(
      makeDeps(async () => SAMPLE_KPI),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/kpi/cost-per-merged-task?days=30`)
      expect(res.status).toBe(200)
      const body = await res.json() as CostPerMergedTaskKpi
      expect(body.current.mergedCount).toBe(3)
      expect(body.current.costUsd).toBeCloseTo(4.5)
      expect(body.current.avgCostPerMerge).toBeCloseTo(1.5)
      expect(body.current.tokens).toBe(1500)
      expect(body.trend).toHaveLength(1)
      expect(body.trend[0]!.day).toBe('2026-01-10')
    } finally {
      await close()
    }
  })

  it('passes the parsed days param to the dep', async () => {
    let capturedWindowDays = -1
    const { startHttpServer } = await import('../../http-server.js')
    const { port, close } = await startHttpServer(
      makeDeps(async (opts) => {
        capturedWindowDays = opts.windowDays
        return EMPTY_KPI
      }),
    )
    try {
      await fetch(`http://127.0.0.1:${port}/kpi/cost-per-merged-task?days=7`)
      expect(capturedWindowDays).toBe(7)
    } finally {
      await close()
    }
  })

  it('defaults days to 30 when the query param is absent', async () => {
    let capturedWindowDays = -1
    const { startHttpServer } = await import('../../http-server.js')
    const { port, close } = await startHttpServer(
      makeDeps(async (opts) => {
        capturedWindowDays = opts.windowDays
        return EMPTY_KPI
      }),
    )
    try {
      await fetch(`http://127.0.0.1:${port}/kpi/cost-per-merged-task`)
      expect(capturedWindowDays).toBe(30)
    } finally {
      await close()
    }
  })

  it('returns 503 when getCostPerMergedTaskKpi dep is not wired up', async () => {
    const { startHttpServer } = await import('../../http-server.js')
    const { port, close } = await startHttpServer(makeDeps(undefined))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/kpi/cost-per-merged-task`)
      expect(res.status).toBe(503)
    } finally {
      await close()
    }
  })

  it('returns empty KPI shape with zeros when dep returns empty data', async () => {
    const { startHttpServer } = await import('../../http-server.js')
    const { port, close } = await startHttpServer(
      makeDeps(async () => EMPTY_KPI),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/kpi/cost-per-merged-task`)
      expect(res.status).toBe(200)
      const body = await res.json() as CostPerMergedTaskKpi
      expect(body.current.mergedCount).toBe(0)
      expect(body.current.costUsd).toBeNull()
      expect(body.current.avgCostPerMerge).toBeNull()
      expect(body.trend).toHaveLength(0)
    } finally {
      await close()
    }
  })
})
