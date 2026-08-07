/**
 * Tests for stale-daemon skew detection in the shared API proxy path.
 *
 * When the daemon returns 404 or 405 for a proxied route, the UI server
 * checks `/view/daemon-version` on the daemon. If the daemon reports
 * that it is running older code (isStale=true, sourceSha ≠ currentSha),
 * the server returns a structured STALE_DAEMON_CODE error with both short
 * SHAs instead of forwarding the raw daemon body.
 *
 * This keeps the HTTP status honest (still 404/405) while replacing the
 * opaque daemon error message with an actionable remedy.
 *
 * The handling lives in the shared proxyGet wrapper, so every /api/* route
 * that proxies to the daemon gets the check automatically — tested here by
 * using different routes (including one invented purely for this test).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DaemonActionResult } from './daemonHttp.ts'
import { DAEMON_ERROR } from '../src/shared/daemonErrors.ts'
import { startServer } from './index.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-stale-daemon-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/** Build a proxyGet stub that simulates a stale daemon. */
const makeStaleProxyGet = (opts: {
  routeStatus: 404 | 405
  sourceSha?: string
  currentSha?: string
  isStale?: boolean
}): (stateDir: string, path: string) => Promise<DaemonActionResult> => {
  const {
    routeStatus,
    sourceSha = 'abc1234567890',
    currentSha = 'def9876543210',
    isStale = true,
  } = opts
  return async (_stateDir, path) => {
    if (path === '/view/daemon-version') {
      return { status: 200, body: { sourceSha, currentSha, isStale } }
    }
    return {
      status: routeStatus,
      body: { ok: false, error: routeStatus === 404 ? 'not found' : 'Method not allowed' },
    }
  }
}

/** Build a proxyGet stub simulating a daemon that is down (NO_DAEMON). */
const makeDownProxyGet = (): (stateDir: string, path: string) => Promise<DaemonActionResult> =>
  async () => ({
    status: 503,
    body: { ok: false, error: 'daemon not running', errorCode: DAEMON_ERROR.NO_DAEMON },
  })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stale daemon skew detection — shared proxy path', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet ──────────────────────────────────────────────────────────

  it('returns STALE_DAEMON_CODE with both SHAs when daemon returns 405 and reports skew', async () => {
    const proxyGet = makeStaleProxyGet({ routeStatus: 405 })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    const baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/deep-reflections`)

    // HTTP status stays honest — the daemon returned 405
    expect(res.status).toBe(405)
    const body = await res.json() as Record<string, unknown>
    expect(body.errorCode).toBe(DAEMON_ERROR.STALE_DAEMON_CODE)
    // Both short SHAs (7 chars) are included in the response
    expect(typeof body.sourceSha).toBe('string')
    expect(typeof body.currentSha).toBe('string')
    expect((body.sourceSha as string).length).toBe(7)
    expect((body.currentSha as string).length).toBe(7)
    expect(body.sourceSha).toBe('abc1234')
    expect(body.currentSha).toBe('def9876')
  })

  // ── Lives in shared path — different routes get the same treatment ─────────

  it('returns STALE_DAEMON_CODE when daemon returns 404 for any proxied route', async () => {
    const proxyGet = makeStaleProxyGet({ routeStatus: 404 })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    const baseUrl = `http://${server.hostname}:${server.port}`

    // Use /api/proposals — a completely different route — to prove the check
    // is in the shared path, not hardcoded for /api/deep-reflections
    const res = await fetch(`${baseUrl}/api/proposals`)
    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(body.errorCode).toBe(DAEMON_ERROR.STALE_DAEMON_CODE)
    expect(body.sourceSha).toBe('abc1234')
    expect(body.currentSha).toBe('def9876')
  })

  // ── Remedy message is included in the error body ───────────────────────────

  it('includes the restart remedy in the error body', async () => {
    const proxyGet = makeStaleProxyGet({ routeStatus: 405 })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    const baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/deep-reflections`)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.error).toBe('string')
    expect((body.error as string).toLowerCase()).toContain('restart')
  })

  // ── No skew: fall through to original response ─────────────────────────────

  it('forwards the original 404 response when daemon is current (isStale=false)', async () => {
    const proxyGet = makeStaleProxyGet({ routeStatus: 404, isStale: false })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    const baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/deep-reflections`)
    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    // Should NOT have the STALE_DAEMON_CODE error code
    expect(body.errorCode).not.toBe(DAEMON_ERROR.STALE_DAEMON_CODE)
  })

  it('forwards the original response when daemon version endpoint also returns 404 (old daemon)', async () => {
    // Simulates an old daemon that has neither the route NOR /view/daemon-version
    const proxyGet = async (_stateDir: string, _path: string): Promise<DaemonActionResult> => ({
      status: 404,
      body: { ok: false, error: 'not found' },
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    const baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/deep-reflections`)
    expect(res.status).toBe(404)
    const body = await res.json() as Record<string, unknown>
    expect(body.errorCode).not.toBe(DAEMON_ERROR.STALE_DAEMON_CODE)
  })

  // ── Three distinguishable cases ────────────────────────────────────────────

  it('daemon-stale (code outdated) has different errorCode than daemon-down (NO_DAEMON)', async () => {
    const staleProxyGet = makeStaleProxyGet({ routeStatus: 405 })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet: staleProxyGet })
    const baseUrl = `http://${server.hostname}:${server.port}`

    const staleRes = await fetch(`${baseUrl}/api/deep-reflections`)
    const staleBody = await staleRes.json() as Record<string, unknown>

    server.stop(true)

    const downProxyGet = makeDownProxyGet()
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet: downProxyGet })
    const baseUrl2 = `http://${server.hostname}:${server.port}`

    const downRes = await fetch(`${baseUrl2}/api/deep-reflections`)
    const downBody = await downRes.json() as Record<string, unknown>

    // The two cases must produce different errorCodes
    expect(staleBody.errorCode).toBe(DAEMON_ERROR.STALE_DAEMON_CODE)
    expect(downBody.errorCode).toBe(DAEMON_ERROR.NO_DAEMON)
    expect(staleBody.errorCode).not.toBe(downBody.errorCode)
  })
})
