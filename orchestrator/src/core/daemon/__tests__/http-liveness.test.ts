/**
 * Tests for GET /liveness — the daemon uptime / heartbeat probe.
 *
 * The route must return 200 with { pid, bootTs, lastBeatTs, uptimeMs, staleMs }
 * when a daemon_heartbeat row exists, and 503 { reason: 'no-heartbeat' } when
 * no row is present yet (daemon starting up or heartbeat writer failed).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

// Mock readDaemonHeartbeat so the route never hits the real database.
vi.mock('../../store/state-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../store/state-store')>()
  return {
    ...original,
    readDaemonHeartbeat: vi.fn(),
  }
})

// Mock resolveStateClient so it never tries to open a real DB connection.
// readDaemonHeartbeat is mocked anyway, so the client argument is irrelevant.
vi.mock('../../store/state-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../store/state-client')>()
  return {
    ...original,
    resolveStateClient: () => ({
      execute: vi.fn(),
      batch: vi.fn(),
      close: vi.fn(),
    }),
  }
})

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-liveness-rec-')),
  )
})

beforeEach(() => {
  vi.clearAllMocks()
})

const makeDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
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
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

describe('GET /liveness', () => {
  it('returns 200 with correct JSON shape when heartbeat row exists', async () => {
    const { readDaemonHeartbeat } = await import('../../store/state-store')
    const now = Date.now()
    const bootTs = now - 60_000   // daemon booted 60 s ago
    const lastBeatTs = now - 3_000 // last beat 3 s ago
    vi.mocked(readDaemonHeartbeat).mockResolvedValue({
      pid: 12345,
      bootTs,
      lastBeatTs,
      prevGapMs: 0,
      dispatchUptimeMs: 0,
    })

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/liveness`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = await res.json() as {
        pid: number
        bootTs: number
        lastBeatTs: number
        uptimeMs: number
        staleMs: number
      }
      expect(body.pid).toBe(12345)
      expect(body.bootTs).toBe(bootTs)
      expect(body.lastBeatTs).toBe(lastBeatTs)
      // uptimeMs = Date.now() - bootTs ≥ 60 000
      expect(body.uptimeMs).toBeGreaterThanOrEqual(60_000)
      // staleMs = Date.now() - lastBeatTs ≥ 3 000
      expect(body.staleMs).toBeGreaterThanOrEqual(3_000)
    } finally {
      await close()
    }
  })

  it('returns 503 with { reason: "no-heartbeat" } when no row exists', async () => {
    const { readDaemonHeartbeat } = await import('../../store/state-store')
    vi.mocked(readDaemonHeartbeat).mockResolvedValue(null)

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/liveness`)
      expect(res.status).toBe(503)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = await res.json()
      expect(body).toEqual({ reason: 'no-heartbeat' })
    } finally {
      await close()
    }
  })
})
