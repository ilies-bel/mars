/**
 * Tests for operator control routes:
 *   GET  /view/operator          — dispatch state + control levers + caps
 *   POST /operator/dispatch      — pause or resume dispatch
 *   POST /operator/recovery      — toggle recovery kill-switch
 *
 * The routes are the HTTP mirror of `mars operator set dispatch|recovery on|off`.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'
import type { DispatchPauseState } from '../pause-state'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-operator-rec-')),
  )
})

const runningState: DispatchPauseState = {
  paused: false,
  reason: null,
  since: null,
  detail: null,
}

const pausedState: DispatchPauseState = {
  paused: true,
  reason: 'operator',
  since: '2026-01-01T00:00:00.000Z',
  detail: 'http operator set dispatch off',
}

const makeDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
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
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  getPauseState: () => runningState,
  pauseDispatch: vi.fn().mockReturnValue(true),
  resumeDispatch: vi.fn(),
  resetSignatureStorm: vi.fn().mockResolvedValue(undefined),
  drainDispatch: vi.fn(),
  ...overrides,
})

// ---------------------------------------------------------------------------
// GET /view/operator
// ---------------------------------------------------------------------------

describe('GET /view/operator', () => {
  it('returns 200 with dispatch state, control levers, and caps', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/operator`)
      expect(res.status).toBe(200)
      const body = await res.json() as {
        dispatch: { paused: boolean; reason: null }
        controlLevers: { recovery: string; scoring: string }
        caps: { implement: number }
      }
      expect(body.dispatch.paused).toBe(false)
      expect(body.dispatch.reason).toBeNull()
      expect(body.controlLevers).toMatchObject({ recovery: expect.any(String), scoring: expect.any(String) })
      expect(body.caps).toMatchObject({ implement: expect.any(Number) })
    } finally {
      await close()
    }
  })

  it('returns live pause state from getPauseState when wired', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ getPauseState: () => pausedState }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/operator`)
      expect(res.status).toBe(200)
      const body = await res.json() as { dispatch: DispatchPauseState }
      expect(body.dispatch.paused).toBe(true)
      expect(body.dispatch.reason).toBe('operator')
    } finally {
      await close()
    }
  })

  it('falls back to readPersistedPaused when getPauseState is absent', async () => {
    // Without getPauseState, the route reads from daemon.json (no file → false).
    const { startHttpServer } = await import('../http-server')
    const deps = makeDeps()
    delete (deps as Partial<HttpServerDeps>).getPauseState
    const { port, close } = await startHttpServer(deps)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/operator`)
      expect(res.status).toBe(200)
      const body = await res.json() as { dispatch: { paused: boolean } }
      // No daemon.json on disk → paused=false (safe default)
      expect(body.dispatch.paused).toBe(false)
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// POST /operator/dispatch
// ---------------------------------------------------------------------------

describe('POST /operator/dispatch', () => {
  it('returns 400 for missing value', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
    } finally {
      await close()
    }
  })

  it('returns 503 when pauseDispatch is not wired', async () => {
    const { startHttpServer } = await import('../http-server')
    const deps = makeDeps()
    delete (deps as Partial<HttpServerDeps>).pauseDispatch
    delete (deps as Partial<HttpServerDeps>).resumeDispatch
    const { port, close } = await startHttpServer(deps)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'off' }),
      })
      expect(res.status).toBe(503)
    } finally {
      await close()
    }
  })

  it('calls pauseDispatch on value=off and returns ok', async () => {
    const pauseDispatch = vi.fn().mockReturnValue(true)
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps({ pauseDispatch }))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'off' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; data: { paused: boolean } }
      expect(body.ok).toBe(true)
      expect(body.data.paused).toBe(true)
      expect(pauseDispatch).toHaveBeenCalledWith('operator', expect.any(String))
    } finally {
      await close()
    }
  })

  it('calls resumeDispatch on value=on and returns ok', async () => {
    const resumeDispatch = vi.fn()
    const resetSignatureStorm = vi.fn().mockResolvedValue(undefined)
    const drainDispatch = vi.fn()
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ resumeDispatch, resetSignatureStorm, drainDispatch }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'on' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; data: { paused: boolean } }
      expect(body.ok).toBe(true)
      expect(body.data.paused).toBe(false)
      expect(resumeDispatch).toHaveBeenCalled()
      expect(resetSignatureStorm).toHaveBeenCalled()
      expect(drainDispatch).toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// POST /operator/recovery
// ---------------------------------------------------------------------------

describe('POST /operator/recovery', () => {
  it('returns 400 for missing value', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/recovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { ok: boolean }
      expect(body.ok).toBe(false)
    } finally {
      await close()
    }
  })

  it('returns 400 for invalid value', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/recovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'yes' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('persists and applies recovery=off, returns ok', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/recovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'off' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; data: { recovery: string } }
      expect(body.ok).toBe(true)
      expect(body.data.recovery).toBe('off')
    } finally {
      await close()
    }
  })

  it('persists and applies recovery=on, returns ok', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operator/recovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'on' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { ok: boolean; data: { recovery: string } }
      expect(body.ok).toBe(true)
      expect(body.data.recovery).toBe('on')
    } finally {
      await close()
    }
  })
})
