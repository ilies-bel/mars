/**
 * Tests for withDaemon's transport-error classification in daemonHttp.ts.
 *
 * The key behaviour under test: a connection-refused error against a stale
 * `.mars/http.port` file must map to 503 / NO_DAEMON (not 502 / PROXY_FAILED)
 * so the UI surfaces "restart daemon" rather than a generic proxy error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { DAEMON_ERROR } from '../src/shared/daemonErrors.ts'
import { proxyGet } from './daemonHttp.ts'

/** Bind a TCP server to an OS-assigned port, then close it so the port is stale. */
const getStalePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })

describe('proxyGet — transport error classification', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mars-daemonhttp-test-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('returns 503 NO_DAEMON when http.port is stale (ECONNREFUSED on real socket)', async () => {
    const stalePort = await getStalePort()
    writeFileSync(join(stateDir, 'http.port'), String(stalePort))

    const result = await proxyGet(stateDir, '/api/tasks')

    expect(result.status).toBe(503)
    expect((result.body as { errorCode: string }).errorCode).toBe(DAEMON_ERROR.NO_DAEMON)
  })

  it('returns 503 NO_DAEMON when ECONNREFUSED surfaces on err.code (Bun-style error)', async () => {
    // Simulate stale-port with Bun's error shape (code on the error itself)
    writeFileSync(join(stateDir, 'http.port'), '58344')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(
        Object.assign(new TypeError('connect ECONNREFUSED 127.0.0.1:58344'), {
          code: 'ECONNREFUSED',
        }),
      ),
    )

    const result = await proxyGet(stateDir, '/api/tasks')

    expect(result.status).toBe(503)
    expect((result.body as { errorCode: string }).errorCode).toBe(DAEMON_ERROR.NO_DAEMON)
  })

  it('returns 503 NO_DAEMON when ECONNREFUSED surfaces on err.cause.code (Node-style error)', async () => {
    // Simulate stale-port with Node's error shape (code on the cause)
    writeFileSync(join(stateDir, 'http.port'), '58344')
    const cause = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause })),
    )

    const result = await proxyGet(stateDir, '/api/tasks')

    expect(result.status).toBe(503)
    expect((result.body as { errorCode: string }).errorCode).toBe(DAEMON_ERROR.NO_DAEMON)
  })

  it('returns 502 PROXY_FAILED for other transport errors (e.g. timeout)', async () => {
    writeFileSync(join(stateDir, 'http.port'), '58344')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('network timeout')),
    )

    const result = await proxyGet(stateDir, '/api/tasks')

    expect(result.status).toBe(502)
    expect((result.body as { errorCode: string }).errorCode).toBe(DAEMON_ERROR.PROXY_FAILED)
  })
})
