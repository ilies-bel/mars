/**
 * Integration tests for the `POST /actions/add-gate/:id` entity route.
 *
 * Drives a real `startHttpServer` with stub deps to exercise the wiring
 * introduced in mars-ba051780: `addGateFromItem` must be supplied in
 * `HttpServerDeps` so the route resolves instead of returning a 500
 * "add-gate not implemented" error.
 *
 * Scope:
 *  - 200 OK when `addGateFromItem` is wired and succeeds
 *  - the dep is called with the correct entity id
 *  - 501 Not Implemented when `addGateFromItem` is absent (stub guard)
 *  - propagates errors from `addGateFromItem` as 500
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import type { HttpServerDeps } from './http-server.js'
import { stubAppServices, stubChatRunner } from './__tests__/app-services-stub.js'
import { loadRecipeCatalog } from '../lib/recipes.js'
import { nullTraceStore } from '../lib/run-tool.js'

// ── Shared setup ──────────────────────────────────────────────────────────────

let recipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>>

beforeAll(async () => {
  const catDir = mkdtempSync(resolvePath(tmpdir(), 'mars-routes-test-cat-'))
  recipeCatalog = await loadRecipeCatalog(catDir)
})

/**
 * Minimal required deps for `startHttpServer`. Optional fields are omitted;
 * tests pass overrides for the specific dep they are exercising.
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
