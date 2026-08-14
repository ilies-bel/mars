/**
 * Regression tests for GET /api/alerts.
 *
 * Root cause (2026-08-14): GET /api/alerts returned 504 on every poll because
 * the daemon's listFailedArcs helper called resolveOriginIdForTask(t.id) in a
 * sequential loop over ALL tasks. With hundreds of tasks this blew past the
 * 10 s proxy timeout. The fix: use t.originId which listTasks() already
 * populates (it is derived from `origin_id ?? id` in rowToTask, the same
 * expression resolveOriginIdForTask executed with an extra DB round-trip per
 * task).
 *
 * These UI-server-layer tests cover the proxy behaviour:
 *   1. Daemon returns 200 + alert array → UI relays it verbatim.
 *   2. Daemon is down (503 NO_DAEMON)   → UI relays 503 immediately — no hang.
 *   3. Daemon returns an empty array    → UI returns 200 [].
 *   4. Daemon returns 404 (route missing on old daemon) → UI relays 404 with
 *      a diagnosable body rather than a hanging 504.
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-alerts-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const makeAlertsStub = (
  result: DaemonActionResult,
): (stateDir: string, path: string) => Promise<DaemonActionResult> =>
  async (_stateDir, path) => {
    if (path === '/alerts') return result
    // skew-detection check for /view/daemon-version — return 404 so the
    // wrapper falls through to the original result rather than enriching it
    return { status: 404, body: { ok: false, error: 'stub: unhandled' } }
  }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/alerts — proxy behaviour', () => {
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

  it('relays a 200 alert array from the daemon verbatim', async () => {
    const alert = {
      arcId: 'arc-001',
      goal: 'Fix login bug',
      reason: 'code phase failed',
      kind: 'arc-failed',
    }
    const proxyGet = makeAlertsStub({ status: 200, body: [alert] })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    const baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/alerts`)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect((body as unknown[])).toHaveLength(1)
    expect((body as Array<{ arcId: string }>)[0]!.arcId).toBe('arc-001')
  })

  it('relays an empty array when the daemon reports no alerts', async () => {
    const proxyGet = makeAlertsStub({ status: 200, body: [] })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    const baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/alerts`)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })

  it('relays 503 NO_DAEMON immediately when the daemon is down — no hang', async () => {
    // Regression: previously any hang in the daemon would manifest as a 504
    // loop. If the daemon is simply absent the proxy must return 503 fast.
    const proxyGet = makeAlertsStub({
      status: 503,
      body: { ok: false, error: 'daemon not running', errorCode: DAEMON_ERROR.NO_DAEMON },
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    const baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/alerts`)

    expect(res.status).toBe(503)
    const body = await res.json() as { errorCode?: string }
    expect(body.errorCode).toBe(DAEMON_ERROR.NO_DAEMON)
  })

  it('relays 404 with a body when the daemon route is missing (old daemon, no hang)', async () => {
    // Regression: a missing daemon route should produce a fast 404 with a
    // diagnosable body — not a hanging 504. The withSkewDetection wrapper
    // checks /view/daemon-version on 404; the stub above returns 404 for that
    // too, so the original 404 is forwarded unchanged.
    const proxyGet = makeAlertsStub({
      status: 404,
      body: { ok: false, error: 'route not found' },
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    const baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/alerts`)

    expect(res.status).toBe(404)
    const body = await res.json() as { ok?: boolean }
    // Must have a parseable body — not a hung connection
    expect(body.ok).toBe(false)
  })
})
