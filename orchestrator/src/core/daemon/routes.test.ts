/**
 * Integration tests for daemon entity-op routes.
 *
 * Covers:
 *
 * ### POST /actions/add-gate/:id
 * Drives a real `startHttpServer` with stub deps to exercise the wiring
 * introduced in mars-ba051780: `addGateFromItem` must be supplied in
 * `HttpServerDeps` so the route resolves instead of returning a 500
 * "add-gate not implemented" error.
 *  - 200 OK when `addGateFromItem` is wired and succeeds
 *  - the dep is called with the correct entity id
 *  - 501 Not Implemented when `addGateFromItem` is absent (stub guard)
 *  - propagates errors from `addGateFromItem` as 500
 *
 * ### POST /actions/enrich-retire/:id
 * Before the fix in mars-34c2ecbd, the `enrich-retire` op was emitted by both
 * `gate-enrichment` and `gate-enrichment-stale` recipes but had no handler
 * registered in `entityHandlers` — every click returned
 * `404 { "error": "Unknown action op: enrich-retire" }`.
 *  1. `POST /actions/enrich-retire/:id` reaches a handler (not 404 "Unknown action op").
 *  2. Every verb op that `gate-enrichment-stale` emits reaches some registered
 *     handler via `POST /actions/:op/:id` — i.e. none returns the "Unknown action op" 404.
 *
 * ### Deep-reflections views
 *  - GET  /view/deep-reflections          — must include `autoEnqueue`
 *  - GET  /view/deep-reflections/:originId — must include `autoEnqueue`
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import type { HttpServerHandle, HttpServerDeps } from './http-server.js'
import type { DeepReflectionsListResult, DeepReflectionDetail } from './http-server.js'
import { stubAppServices, stubChatRunner } from './__tests__/app-services-stub.js'
import { loadRecipeCatalog } from '../lib/recipes.js'
import { nullTraceStore } from '../lib/run-tool.js'
import { lookupRecipe, getRecipeVerbs } from '../lib/action-queue-recipes.js'
import type { RecipeCatalog } from '../lib/recipes.js'

// ── Shared setup ──────────────────────────────────────────────────────────────

let recipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>>

beforeAll(async () => {
  const catDir = mkdtempSync(resolvePath(tmpdir(), 'mars-routes-test-cat-'))
  recipeCatalog = await loadRecipeCatalog(catDir)
})

// Null recipe catalog — enrich-retire tests do not use recipe lookups.
const nullRecipeCatalog = null as unknown as RecipeCatalog

/**
 * Ops the daemon handles via special routes or that the client dispatches
 * without hitting `POST /actions/:op/:id` at all. These are excluded from
 * the "every emitted op has a handler" assertion.
 *
 * `copy`          — client-side clipboard verb, never POSTed to the daemon.
 * `snooze`        — handled by the dedicated `POST /actions/snooze/:id` route.
 * `dismiss`       — handled by entityHandlers (dismissProposal), but the
 *                   gate-enrichment-stale recipe does not emit it.
 * `show-all`      — client-side pagination verb, never POSTed.
 * `grill`         — client-side thread-open verb, never POSTed.
 * `restart-daemon`, `resume-dispatch`, `run-reflect`,
 * `continue-all-daemon-killed` — handled by dedicated process-level routes.
 */
const EXCLUDED_OPS = new Set([
  'copy',
  'snooze',
  'show-all',
  'grill',
  'restart-daemon',
  'resume-dispatch',
  'run-reflect',
  'continue-all-daemon-killed',
])

/**
 * Minimal required deps for `startHttpServer`. Optional fields are omitted;
 * tests pass overrides for the specific dep they are exercising.
 * Uses a real `recipeCatalog` loaded in `beforeAll`.
 */
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
  recipeCatalog,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

/**
 * Minimal deps variant with a null recipe catalog — for route-registration
 * tests that do not exercise recipe lookups.
 */
const makeMinimalDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
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
  recipeCatalog: nullRecipeCatalog,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

/** POST to the running server and return status + parsed JSON body. */
const post = async (
  port: number,
  path: string,
): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' })
  const body = await res.json()
  return { status: res.status, body }
}

// ── POST /actions/add-gate/:id ────────────────────────────────────────────────

describe('POST /actions/add-gate/:id', () => {
  let httpServer: { port: number; close: () => Promise<void> } | null = null
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(resolvePath(tmpdir(), 'mars-routes-add-gate-'))
  })

  afterEach(async () => {
    await httpServer?.close()
    httpServer = null
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 200 and calls addGateFromItem with the entity id', async () => {
    const calledWith: string[] = []

    const { startHttpServer } = await import('./http-server.js')
    httpServer = await startHttpServer(
      makeDeps({
        addGateFromItem: async (id) => {
          calledWith.push(id)
        },
      }),
    )

    const { status, body } = await post(httpServer.port, '/actions/add-gate/aq-test-001')

    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true })
    expect(calledWith).toEqual(['aq-test-001'])
  })

  it('does not return "add-gate not implemented" when addGateFromItem is wired', async () => {
    const { startHttpServer } = await import('./http-server.js')
    httpServer = await startHttpServer(
      makeDeps({
        addGateFromItem: async () => {},
      }),
    )

    const { status, body } = await post(httpServer.port, '/actions/add-gate/aq-any-id')

    // 200 means the handler ran — no "not implemented" error was thrown
    expect(status).toBe(200)
    expect((body as Record<string, unknown>).ok).toBe(true)
    expect((body as Record<string, unknown>).error).toBeUndefined()
  })

  it('returns 501 when addGateFromItem is absent (unimplemented stub guard)', async () => {
    const { startHttpServer } = await import('./http-server.js')
    // Omit addGateFromItem so the entityHandler stub fires.
    httpServer = await startHttpServer(makeDeps())

    const { status, body } = await post(httpServer.port, '/actions/add-gate/aq-missing-dep')

    expect(status).toBe(501)
    const bodyObj = body as Record<string, unknown>
    expect(bodyObj.ok).toBe(false)
    expect(typeof bodyObj.error).toBe('string')
  })

  it('propagates thrown errors from addGateFromItem as 500', async () => {
    const { startHttpServer } = await import('./http-server.js')
    httpServer = await startHttpServer(
      makeDeps({
        addGateFromItem: async () => {
          throw new Error('simulated internal failure')
        },
      }),
    )

    const { status, body } = await post(httpServer.port, '/actions/add-gate/aq-err-id')

    expect(status).toBe(500)
    const bodyObj = body as Record<string, unknown>
    expect(bodyObj.ok).toBe(false)
    expect(bodyObj.error).toContain('simulated internal failure')
  })
})

// ── POST /actions/enrich-retire/:id ───────────────────────────────────────────

describe('POST /actions/enrich-retire/:id — handler registration', () => {
  let server: HttpServerHandle | null = null

  afterEach(async () => {
    if (server) {
      await server.close()
      server = null
    }
  })

  it('calls handleEnrichRetire when registered — not 404 Unknown action op', async () => {
    const { startHttpServer } = await import('./http-server')
    const handled = vi.fn().mockResolvedValue(undefined)
    server = await startHttpServer(
      makeMinimalDeps({ handleEnrichRetire: handled }),
    )

    const res = await fetch(
      `http://127.0.0.1:${server.port}/actions/enrich-retire/gate-enrichment-stale%3Averify%3Abuild%2Ftypecheck-error`,
      { method: 'POST' },
    )

    // The route is registered — must not be the "Unknown action op" 404.
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true })
    expect(body.error).toBeUndefined()
    expect(handled).toHaveBeenCalledOnce()
    expect(handled).toHaveBeenCalledWith(
      'gate-enrichment-stale:verify:build/typecheck-error',
    )
  })

  it('returns 501 (not 404 Unknown action op) when handleEnrichRetire is absent', async () => {
    const { startHttpServer } = await import('./http-server')
    // Provide deps WITHOUT handleEnrichRetire — it is optional.
    server = await startHttpServer(makeMinimalDeps())

    const res = await fetch(
      `http://127.0.0.1:${server.port}/actions/enrich-retire/some-entity-id`,
      { method: 'POST' },
    )

    // The route IS registered (it throws NOT_IMPLEMENTED), so the response
    // must be 501, not 404 with "Unknown action op: enrich-retire".
    // (routes.ts maps code:'NOT_IMPLEMENTED' → 501; code-less errors → 500.)
    expect(res.status).toBe(501)
    const body = (await res.json()) as Record<string, unknown>
    // Critical: must NOT be the "Unknown action op" error.
    expect(String(body.error)).not.toMatch('Unknown action op')
    // The handler throws a typed "not implemented" error.
    expect(String(body.error)).toMatch('enrich-retire not implemented')
  })
})

// ── Recipe coverage — gate-enrichment-stale emits enrich-retire ───────────────

describe('gate-enrichment-stale recipe — enrich-retire verb coverage', () => {
  const makeCtx = (kind: string) => ({
    kind: kind as Parameters<typeof lookupRecipe>[0],
    entityId: 'gate-enrichment-stale:verify:build/typecheck-error',
    payload: { signature: 'verify:build/typecheck-error', passCount: 5 },
    context: {},
    title: '',
    body: '',
    raisedAt: '2026-09-01T00:00:00.000Z',
  })

  it('gate-enrichment-stale recipe emits enrich-retire verb', () => {
    const recipe = lookupRecipe('gate-enrichment-stale')
    const ctx = makeCtx('gate-enrichment-stale')
    const verbs = getRecipeVerbs(recipe, ctx)
    expect(verbs.some((v) => v.op === 'enrich-retire')).toBe(true)
  })

  it('gate-enrichment recipe emits enrich-retire verb', () => {
    const recipe = lookupRecipe('gate-enrichment')
    const ctx = makeCtx('gate-enrichment')
    const verbs = getRecipeVerbs(recipe, ctx)
    expect(verbs.some((v) => v.op === 'enrich-retire')).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // End-to-end: every verb op gate-enrichment-stale emits that would reach
  // POST /actions/:op/:id has a registered handler (does not 404 "Unknown action op").
  // ---------------------------------------------------------------------------

  let server: HttpServerHandle | null = null

  afterEach(async () => {
    if (server) {
      await server.close()
      server = null
    }
  })

  it('every gate-enrichment-stale verb op that reaches entityHandlers has a handler', async () => {
    const { startHttpServer } = await import('./http-server')
    server = await startHttpServer(
      makeMinimalDeps({ handleEnrichRetire: async () => {} }),
    )

    const recipe = lookupRecipe('gate-enrichment-stale')
    const ctx = {
      kind: 'gate-enrichment-stale' as const,
      entityId: 'gate-enrichment-stale:verify:build/typecheck-error',
      payload: { signature: 'verify:build/typecheck-error', passCount: 5 },
      context: {},
      title: 'Stale gate enrichment',
      body: '',
      raisedAt: '2026-09-01T00:00:00.000Z',
    }
    const verbs = getRecipeVerbs(recipe, ctx)

    for (const verb of verbs) {
      // Skip ops handled outside the entityHandlers dispatch.
      if (EXCLUDED_OPS.has(verb.op)) continue

      const res = await fetch(
        `http://127.0.0.1:${server.port}/actions/${encodeURIComponent(verb.op)}/test-entity-id`,
        { method: 'POST' },
      )
      const body = (await res.json()) as Record<string, unknown>

      // The only unacceptable outcome is the "Unknown action op" 404 — that
      // means the op is not registered at all. 200, 500, or 501 all mean
      // the route reached a handler.
      expect(
        String(body.error ?? ''),
        `op "${verb.op}" returned "Unknown action op: ${verb.op}" — not registered in entityHandlers`,
      ).not.toMatch(`Unknown action op: ${verb.op}`)
    }
  })
})

// ── GET /view/deep-reflections — autoEnqueue field ────────────────────────────

describe('GET /view/deep-reflections includes autoEnqueue', () => {
  let httpServer: { port: number; close: () => Promise<void> } | null = null

  afterEach(async () => {
    await httpServer?.close()
    httpServer = null
  })

  it('includes autoEnqueue in the list response', async () => {
    const { startHttpServer } = await import('./http-server.js')

    const listResult: DeepReflectionsListResult = {
      reports: [],
      totalDiscovered: 0,
      unreadableCount: 0,
      autoRunReflect: 'on',
      autoEnqueue: true,
      lastReflectedAt: null,
    }

    httpServer = await startHttpServer(
      makeDeps({ appServices: stubAppServices({ viewDeepReflections: async () => listResult }) }),
    )

    const res = await fetch(`http://127.0.0.1:${httpServer.port}/view/deep-reflections`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as DeepReflectionsListResult
    expect(body.autoEnqueue).toBe(true)
  })

  it('passes autoEnqueue=false through when the feature is disabled', async () => {
    const { startHttpServer } = await import('./http-server.js')

    const listResult: DeepReflectionsListResult = {
      reports: [],
      totalDiscovered: 0,
      unreadableCount: 0,
      autoRunReflect: 'off',
      autoEnqueue: false,
      lastReflectedAt: null,
    }

    httpServer = await startHttpServer(
      makeDeps({ appServices: stubAppServices({ viewDeepReflections: async () => listResult }) }),
    )

    const res = await fetch(`http://127.0.0.1:${httpServer.port}/view/deep-reflections`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as DeepReflectionsListResult
    expect(body.autoEnqueue).toBe(false)
  })
})

// ── GET /view/deep-reflections/:originId — autoEnqueue field ──────────────────

describe('GET /view/deep-reflections/:originId includes autoEnqueue', () => {
  let httpServer: { port: number; close: () => Promise<void> } | null = null

  afterEach(async () => {
    await httpServer?.close()
    httpServer = null
  })

  it('includes autoEnqueue in the detail response', async () => {
    const { startHttpServer } = await import('./http-server.js')

    const detail: DeepReflectionDetail = {
      originId: 'test-origin',
      recordedAt: '2026-09-01T12:00:00.000Z',
      status: 'complete',
      totalToolCalls: 10,
      dissonantCallCount: 0,
      verifyMismatchCount: 0,
      thrashingPatternCount: 0,
      verdictResult: { saved: 0, absorbed: 0, dropped: 0 },
      sourceTaskId: null,
      autoRunReflect: 'on',
      autoEnqueue: true,
      report: null,
    }

    httpServer = await startHttpServer(
      makeDeps({ appServices: stubAppServices({ viewDeepReflection: async () => detail }) }),
    )

    const res = await fetch(
      `http://127.0.0.1:${httpServer.port}/view/deep-reflections/${encodeURIComponent('test-origin')}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as DeepReflectionDetail
    expect(body.autoEnqueue).toBe(true)
  })

  it('passes autoEnqueue=false through for the detail view when disabled', async () => {
    const { startHttpServer } = await import('./http-server.js')

    const detail: DeepReflectionDetail = {
      originId: 'test-origin-2',
      recordedAt: '2026-09-01T12:00:00.000Z',
      status: 'complete',
      totalToolCalls: 5,
      dissonantCallCount: 0,
      verifyMismatchCount: 0,
      thrashingPatternCount: 0,
      verdictResult: { saved: 0, absorbed: 0, dropped: 0 },
      sourceTaskId: null,
      autoRunReflect: 'off',
      autoEnqueue: false,
      report: null,
    }

    httpServer = await startHttpServer(
      makeDeps({ appServices: stubAppServices({ viewDeepReflection: async () => detail }) }),
    )

    const res = await fetch(
      `http://127.0.0.1:${httpServer.port}/view/deep-reflections/${encodeURIComponent('test-origin-2')}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as DeepReflectionDetail
    expect(body.autoEnqueue).toBe(false)
  })
})
