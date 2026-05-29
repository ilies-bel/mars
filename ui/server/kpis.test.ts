/**
 * Tests for:
 *   1. The daemon GET /kpis handler shape (starts a real Node.js http server).
 *   2. The UI server proxy helper fetchKpis (mocked fetch + readFile).
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startHttpServer } from '../../orchestrator/src/mastra/daemon/http-server.ts'
import type { HttpServerDeps } from '../../orchestrator/src/mastra/daemon/http-server.ts'
import { loadFailureReasonCatalog } from '../../orchestrator/src/mastra/lib/failure-reasons.ts'
import { loadRecipeCatalog } from '../../orchestrator/src/mastra/lib/recipes.ts'
import { nullTraceStore } from '../../orchestrator/src/mastra/lib/run-tool.ts'
import { fetchKpis } from './daemonHttp.ts'
import type { KpiRecord } from './daemonHttp.ts'

let cachedFailureCatalog: Awaited<ReturnType<typeof loadFailureReasonCatalog>> | null = null
let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

beforeAll(async () => {
  cachedFailureCatalog = await loadFailureReasonCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-kpi-fr-')),
  )
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-kpi-rec-')),
  )
})

const makeKpiDeps = (kpis: KpiRecord[]): HttpServerDeps => ({
  restartTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  restartAllDaemonKilled: async () => [],
  isAcceptingWork: () => true,
  failureReasonCatalog:
    cachedFailureCatalog as Awaited<ReturnType<typeof loadFailureReasonCatalog>>,
  recipeCatalog:
    cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  listKpis: async () => kpis,
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
