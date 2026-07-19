/**
 * Integration tests for the /api/preferences/notifications proxy routes.
 *
 * These routes were missing from the UI server, causing the nav-bar desktop-
 * notifications toggle to 404 on every page load. Verified here that:
 *  - GET /api/preferences/notifications proxies the daemon response.
 *  - PUT /api/preferences/notifications is not a 404 (reaches the proxy layer;
 *    returns 503 when daemon is absent, NOT 404).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startServer } from './index.ts'
import type { DaemonActionResult } from './daemonHttp.ts'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-prefs-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/** Minimal proxyGet stub that serves the notifications preference endpoint. */
const makePrefsStub = (
  enabled: boolean,
): ((stateDir: string, path: string) => Promise<DaemonActionResult>) => {
  return async (_stateDir, path) => {
    if (path === '/preferences/notifications') {
      return { status: 200, body: { enabled } }
    }
    return { status: 404, body: { error: `stub: unhandled ${path}` } }
  }
}

describe('GET /api/preferences/notifications', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: makePrefsStub(true) },
    )
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 200 with the daemon notification preference', async () => {
    const res = await fetch(`${baseUrl}/api/preferences/notifications`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { enabled: boolean }
    expect(body.enabled).toBe(true)
  })

  it('relays enabled=false from the daemon', async () => {
    server?.stop(true)
    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: makePrefsStub(false) },
    )
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/preferences/notifications`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { enabled: boolean }
    expect(body.enabled).toBe(false)
  })
})

describe('PUT /api/preferences/notifications', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    // No proxyGet needed for the PUT route; it uses proxyPost directly.
    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      {},
    )
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 503 (daemon unavailable) not 404 (route missing)', async () => {
    // With no daemon running the proxy returns 503 — this proves the route is
    // registered. A 404 would mean the route was never matched.
    const res = await fetch(`${baseUrl}/api/preferences/notifications`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(503)
    expect(res.status).not.toBe(404)
  })
})
