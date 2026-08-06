/**
 * Tests for GET /healthz — the UI liveness probe.
 *
 * The route must return 200 { ok: true } regardless of whether the daemon
 * is draining, so the UI correctly reports a live-but-draining daemon as
 * 'live' rather than 'down'.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-healthz-rec-')),
  )
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

describe('GET /healthz', () => {
  it('returns 200 { ok: true } when the daemon is accepting work', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = await res.json()
      expect(body).toEqual({ ok: true })
    } finally {
      await close()
    }
  })

  it('returns 200 { ok: true } even when the daemon is draining (isAcceptingWork = false)', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps({ isAcceptingWork: () => false }))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ ok: true })
    } finally {
      await close()
    }
  })
})
