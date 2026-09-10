/**
 * Tests for POST /operator/:lever — the generic control-lever write route.
 *
 * Covers:
 *   - A valid lever (auto-run-reflect) round-trips: POST sets the value and
 *     GET /view/operator reflects it immediately (same validation the CLI uses).
 *   - An unknown lever name is rejected with 400, naming the valid set.
 *   - An invalid value (neither 'on' nor 'off') is rejected with 400.
 *   - The response body includes the lever name and new value on success.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import type { HttpServerDeps } from '../daemon/http-server.js'
import { stubAppServices, stubChatRunner } from '../daemon/__tests__/app-services-stub.js'
import { nullTraceStore } from '../lib/run-tool.js'
import { loadRecipeCatalog } from '../lib/recipes.js'
import { __resetContextCacheForTests } from '../context.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** POST JSON to the running server; returns { status, body }. */
const postJson = async (
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

/** GET JSON from the running server; returns { status, body }. */
const getJson = async (
  port: number,
  path: string,
): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'GET' })
  return { status: res.status, body: await res.json() }
}

/** Build minimal HttpServerDeps sufficient for operator lever routes. */
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
  recipeCatalog: null as unknown as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

// ── Test suite ────────────────────────────────────────────────────────────────

describe('POST /operator/:lever', () => {
  let httpServer: { port: number; close: () => Promise<void> } | null = null
  let tmpDir: string
  let origMarsRepo: string | undefined

  beforeEach(() => {
    // Create a temp dir that acts as the repo root; daemon.json goes into
    // <tmpDir>/.mars/daemon.json. Set MARS_REPO so resolveContext() picks it up.
    tmpDir = mkdtempSync(resolvePath(tmpdir(), 'mars-lever-route-test-'))
    origMarsRepo = process.env['MARS_REPO']
    process.env['MARS_REPO'] = tmpDir
    // Clear the module-level context cache so it re-resolves from MARS_REPO.
    __resetContextCacheForTests()
  })

  afterEach(async () => {
    await httpServer?.close()
    httpServer = null
    // Restore env and context cache.
    if (origMarsRepo === undefined) {
      delete process.env['MARS_REPO']
    } else {
      process.env['MARS_REPO'] = origMarsRepo
    }
    __resetContextCacheForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('sets auto-run-reflect lever and reflects in GET /view/operator', async () => {
    const { startHttpServer } = await import('../daemon/http-server.js')
    httpServer = await startHttpServer(makeDeps())

    // Default value should be 'off'.
    const before = await getJson(httpServer.port, '/view/operator')
    const beforeState = before.body as { controlLevers: { autoRunReflect: string } }
    expect(beforeState.controlLevers.autoRunReflect).toBe('off')

    // Set auto-run-reflect to 'on'.
    const setResult = await postJson(httpServer.port, '/operator/auto-run-reflect', { value: 'on' })
    expect(setResult.status).toBe(200)
    expect((setResult.body as Record<string, unknown>).ok).toBe(true)
    const data = (setResult.body as { data?: Record<string, unknown> }).data
    expect(data?.['auto-run-reflect']).toBe('on')

    // GET /view/operator should now show the updated value.
    const after = await getJson(httpServer.port, '/view/operator')
    const afterState = after.body as { controlLevers: { autoRunReflect: string } }
    expect(afterState.controlLevers.autoRunReflect).toBe('on')
  })

  it('sets scoring lever on and reflects in GET /view/operator', async () => {
    const { startHttpServer } = await import('../daemon/http-server.js')
    httpServer = await startHttpServer(makeDeps())

    // Default is 'on'; set to 'off' to confirm mutation.
    const setResult = await postJson(httpServer.port, '/operator/scoring', { value: 'off' })
    expect(setResult.status).toBe(200)
    const data = (setResult.body as { data?: Record<string, unknown> }).data
    expect(data?.['scoring']).toBe('off')

    const after = await getJson(httpServer.port, '/view/operator')
    const afterState = after.body as { controlLevers: { scoring: string } }
    expect(afterState.controlLevers.scoring).toBe('off')
  })

  it('rejects an unknown lever name with 400 naming the valid set', async () => {
    const { startHttpServer } = await import('../daemon/http-server.js')
    httpServer = await startHttpServer(makeDeps())

    const result = await postJson(httpServer.port, '/operator/banana-lever', { value: 'on' })
    expect(result.status).toBe(400)
    const body = result.body as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(typeof body.error).toBe('string')
    // Error message must name the unknown lever.
    expect((body.error as string)).toContain('banana-lever')
    // Error message must name at least some valid levers.
    expect((body.error as string)).toContain('auto-run-reflect')
  })

  it('rejects an invalid value with 400', async () => {
    const { startHttpServer } = await import('../daemon/http-server.js')
    httpServer = await startHttpServer(makeDeps())

    const result = await postJson(httpServer.port, '/operator/recovery', { value: 'maybe' })
    expect(result.status).toBe(400)
    const body = result.body as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(typeof body.error).toBe('string')
  })

  it('rejects a missing value field with 400', async () => {
    const { startHttpServer } = await import('../daemon/http-server.js')
    httpServer = await startHttpServer(makeDeps())

    const result = await postJson(httpServer.port, '/operator/memory-capture', {})
    expect(result.status).toBe(400)
    const body = result.body as Record<string, unknown>
    expect(body.ok).toBe(false)
  })
})
