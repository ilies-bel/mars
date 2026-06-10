/**
 * Tests for:
 *   1. The daemon GET /kpis handler shape (starts a real Node.js http server).
 *   2. The UI server proxy helper fetchKpis (mocked fetch + readFile).
 *   3. The daemon GET /kpis/series handler shape.
 *   4. The UI server proxy helper fetchKpiSeries.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startHttpServer } from '../../orchestrator/src/core/daemon/http-server.ts'
import type { HttpServerDeps } from '../../orchestrator/src/core/daemon/http-server.ts'
import type { KpiSeries } from '../../orchestrator/src/core/lib/kpi-snapshots.ts'
import { loadRecipeCatalog } from '../../orchestrator/src/core/lib/recipes.ts'
import { nullTraceStore } from '../../orchestrator/src/core/lib/run-tool.ts'
import { fetchKpis, fetchKpiSeries } from './daemonHttp.ts'
import type { KpiRecord } from './daemonHttp.ts'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-kpi-rec-')),
  )
})

const makeKpiDeps = (kpis: KpiRecord[], seriesOverride?: (limit: number) => Promise<KpiSeries>): HttpServerDeps => ({
  restartTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  restartAllDaemonKilled: async () => [],
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},
  recipeCatalog:
    cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  appServices: {
    viewActionQueue: async () => [],
    viewActionQueueHistory: async () => ({ rows: [], nextCursor: null }),
    viewAlerts: async () => [],
    viewAlert: async () => null,
    listKpis: async () => kpis,
    listKpisSeries: seriesOverride ?? (async (_limit: number) => ({
      failure_rate: [],
      autonomous_completion_rate: [],
      recovery_success_rate: [],
      cost_per_arc_p50: [],
    })),
    listKpiArcs: async () => ({
      key: 'failure_rate' as const,
      window: { windowStart: '', windowEnd: '' },
      arcs: [],
    }),
    viewTasks: async () => ({ tasks: [] }),
    viewProgress: async () => ({ tasks: [], proposals: [] }),
    viewProposals: async () => ({ drafts: [], staleWorktrees: [] }),
    viewProposal: async () => null,
    viewStepSpans: async () => ({ spans: [] }),
    viewSessions: async () => ({ sessions: [] }),
    viewTerminalEvents: async () => ({ events: [] }),
    viewReleaseNotes: async () => ({ entries: [] }),
    viewReflect: async () => ({
      entries: [],
      costSummary: {
        totalWeightedTokens: 0,
        taskCount: 0,
        successCount: 0,
        failureCount: 0,
        cacheHitRatio: 0,
        topTokenHeavyTasks: [],
        topExpensiveSteps: [],
        tokensByStep: [],
      },
    }),
    viewArcs: async () => [],
    viewFrameworkUpdate: async () => ({
      installed: '0.1.0',
      latest: '0.1.0',
      available: false,
      checkedAt: null,
      releaseUrl: null,
      selfUpdatable: false,
    }),
  },
})

// ---------------------------------------------------------------------------
// Shared fixture KPI data
// ---------------------------------------------------------------------------

const FIXTURE_KPIS: KpiRecord[] = [
  { key: 'cost_per_arc', currentValue: 1.5, priorValue: 1.2, delta: 0.3, sampleCount: 10, lowConfidence: false },
  { key: 'failure_rate', currentValue: 0.05, priorValue: 0.08, delta: -0.03, sampleCount: 10, lowConfidence: false },
  { key: 'autonomous_completion_rate', currentValue: 0.9, priorValue: 0.85, delta: 0.05, sampleCount: 10, lowConfidence: false },
  { key: 'recovery_success_rate', currentValue: 0.75, priorValue: 0.7, delta: 0.05, sampleCount: 10, lowConfidence: false },
]

// ---------------------------------------------------------------------------
// 1. Daemon GET /kpis handler shape
// ---------------------------------------------------------------------------

describe('Daemon GET /kpis', () => {
  it('returns {kpis} with the four ADR-0038 keys and correct numeric fields', async () => {
    const handle = await startHttpServer(makeKpiDeps(FIXTURE_KPIS))

    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/kpis`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { kpis: KpiRecord[] }
      expect(Array.isArray(body.kpis)).toBe(true)
      expect(body.kpis).toHaveLength(4)

      const keys = body.kpis.map((k) => k.key)
      expect(keys).toContain('cost_per_arc')
      expect(keys).toContain('failure_rate')
      expect(keys).toContain('autonomous_completion_rate')
      expect(keys).toContain('recovery_success_rate')

      for (const kpi of body.kpis) {
        expect(typeof kpi.currentValue).toBe('number')
        expect(typeof kpi.priorValue).toBe('number')
        expect(typeof kpi.delta).toBe('number')
        expect(typeof kpi.sampleCount).toBe('number')
        expect(typeof kpi.lowConfidence).toBe('boolean')
      }
    } finally {
      await handle.close()
    }
  })

  it('reflects the injected listKpis values in the response', async () => {
    const handle = await startHttpServer(makeKpiDeps(FIXTURE_KPIS))

    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/kpis`)
      const body = (await res.json()) as { kpis: KpiRecord[] }
      const costArc = body.kpis.find((k) => k.key === 'cost_per_arc')
      expect(costArc?.currentValue).toBe(1.5)
      expect(costArc?.sampleCount).toBe(10)
      expect(costArc?.lowConfidence).toBe(false)
    } finally {
      await handle.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. UI server proxy — fetchKpis
// ---------------------------------------------------------------------------

describe('fetchKpis (UI server proxy helper)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns an empty array when the daemon port file is absent', async () => {
    // Simulate missing port file by pointing at a path that doesn't exist.
    const result = await fetchKpis('/tmp/mars-no-such-dir-kpi-test')
    expect(result).toEqual([])
  })

  it('returns kpis from the daemon when the port file is valid', async () => {
    // Start a real daemon server and point fetchKpis at its port via a temp file.
    const { writeFile } = await import('node:fs/promises')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = mkdtempSync(join(tmpdir(), 'mars-kpi-proxy-test-'))
    const handle = await startHttpServer(makeKpiDeps(FIXTURE_KPIS))

    try {
      await writeFile(join(dir, 'http.port'), String(handle.port))
      const kpis = await fetchKpis(dir)
      expect(Array.isArray(kpis)).toBe(true)
      expect(kpis).toHaveLength(4)
      const costArc = kpis.find((k) => k.key === 'cost_per_arc')
      expect(costArc?.currentValue).toBe(1.5)
    } finally {
      await handle.close()
      const { rmSync } = await import('node:fs')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Daemon GET /kpis/series handler shape
// ---------------------------------------------------------------------------

const FIXTURE_SERIES: KpiSeries = {
  failure_rate: [{ takenAt: '2026-01-01T00:00:00Z', value: 0.05 }],
  autonomous_completion_rate: [{ takenAt: '2026-01-01T00:00:00Z', value: 0.9 }],
  recovery_success_rate: [{ takenAt: '2026-01-01T00:00:00Z', value: 0.75 }],
  cost_per_arc_p50: [{ takenAt: '2026-01-01T00:00:00Z', value: 1200 }],
}

describe('Daemon GET /kpis/series', () => {
  it('returns { series } with the four per-column arrays', async () => {
    const handle = await startHttpServer(
      makeKpiDeps(FIXTURE_KPIS, async () => FIXTURE_SERIES),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/kpis/series`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { series: KpiSeries }
      expect(Array.isArray(body.series.failure_rate)).toBe(true)
      expect(Array.isArray(body.series.autonomous_completion_rate)).toBe(true)
      expect(Array.isArray(body.series.recovery_success_rate)).toBe(true)
      expect(Array.isArray(body.series.cost_per_arc_p50)).toBe(true)
      expect(body.series.failure_rate[0].takenAt).toBe('2026-01-01T00:00:00Z')
      expect(body.series.failure_rate[0].value).toBe(0.05)
    } finally {
      await handle.close()
    }
  })

  it('honours the ?limit= query parameter by passing it to the injected fn', async () => {
    let capturedLimit = -1
    const seriesFn = async (lim: number): Promise<KpiSeries> => {
      capturedLimit = lim
      return FIXTURE_SERIES
    }
    const handle = await startHttpServer(makeKpiDeps(FIXTURE_KPIS, seriesFn))
    try {
      await fetch(`http://127.0.0.1:${handle.port}/kpis/series?limit=7`)
      expect(capturedLimit).toBe(7)
    } finally {
      await handle.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. UI server proxy — fetchKpiSeries
// ---------------------------------------------------------------------------

describe('fetchKpiSeries (UI server proxy helper)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns an empty-series object when the daemon port file is absent', async () => {
    const result = await fetchKpiSeries('/tmp/mars-no-such-dir-kpi-series-test')
    expect(result.failure_rate).toEqual([])
    expect(result.autonomous_completion_rate).toEqual([])
    expect(result.recovery_success_rate).toEqual([])
    expect(result.cost_per_arc_p50).toEqual([])
  })

  it('returns the series from the daemon when the port file is valid', async () => {
    const { writeFile } = await import('node:fs/promises')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = mkdtempSync(join(tmpdir(), 'mars-kpi-series-proxy-test-'))
    const handle = await startHttpServer(
      makeKpiDeps(FIXTURE_KPIS, async () => FIXTURE_SERIES),
    )

    try {
      await writeFile(join(dir, 'http.port'), String(handle.port))
      const series = await fetchKpiSeries(dir)
      expect(series.failure_rate).toHaveLength(1)
      expect(series.failure_rate[0].takenAt).toBe('2026-01-01T00:00:00Z')
      expect(series.cost_per_arc_p50[0].value).toBe(1200)
    } finally {
      await handle.close()
      const { rmSync } = await import('node:fs')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
