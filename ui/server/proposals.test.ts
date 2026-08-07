/**
 * Tests for the /api/proposals endpoint: query-param forwarding (parity
 * between frontend and server), response shape, and the total/nextCursor
 * pagination fields.
 *
 * "Parity test" means: if the frontend sends a query parameter the server
 * silently ignores, this test fails — it captures what the proxyGet stub
 * actually received and asserts the param arrived.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DaemonActionResult } from './daemonHttp.ts'
import { startServer } from './index.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-proposals-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/** Build a proxyGet stub that records calls and returns the supplied body. */
const makeCapturingStub = (
  responseBody: unknown,
): {
  proxyGet: (stateDir: string, path: string) => Promise<DaemonActionResult>
  calls: string[]
} => {
  const calls: string[] = []
  return {
    calls,
    proxyGet: async (_stateDir, path) => {
      calls.push(path)
      return { status: 200, body: responseBody }
    },
  }
}

interface ProposalsBody {
  drafts: unknown[]
  total: number
  nextCursor: string | null
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/proposals — query-param forwarding (parity test)', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('forwards source= to the daemon', async () => {
    const { proxyGet, calls } = makeCapturingStub({
      drafts: [],
      total: 0,
      nextCursor: null,
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    baseUrl = `http://${server.hostname}:${server.port}`

    await fetch(`${baseUrl}/api/proposals?source=reflection`)
    expect(calls).toHaveLength(1)
    const daemonUrl = new URL(calls[0]!, 'http://stub')
    expect(daemonUrl.pathname).toBe('/view/proposals')
    expect(daemonUrl.searchParams.get('source')).toBe('reflection')
  })

  it('forwards status= to the daemon', async () => {
    const { proxyGet, calls } = makeCapturingStub({
      drafts: [],
      total: 0,
      nextCursor: null,
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    baseUrl = `http://${server.hostname}:${server.port}`

    await fetch(`${baseUrl}/api/proposals?status=draft`)
    const daemonUrl = new URL(calls[0]!, 'http://stub')
    expect(daemonUrl.searchParams.get('status')).toBe('draft')
  })

  it('forwards limit= to the daemon', async () => {
    const { proxyGet, calls } = makeCapturingStub({
      drafts: [],
      total: 0,
      nextCursor: null,
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    baseUrl = `http://${server.hostname}:${server.port}`

    await fetch(`${baseUrl}/api/proposals?limit=25`)
    const daemonUrl = new URL(calls[0]!, 'http://stub')
    expect(daemonUrl.searchParams.get('limit')).toBe('25')
  })

  it('forwards cursor= to the daemon', async () => {
    const { proxyGet, calls } = makeCapturingStub({
      drafts: [],
      total: 0,
      nextCursor: null,
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    baseUrl = `http://${server.hostname}:${server.port}`

    await fetch(`${baseUrl}/api/proposals?cursor=50`)
    const daemonUrl = new URL(calls[0]!, 'http://stub')
    expect(daemonUrl.searchParams.get('cursor')).toBe('50')
  })

  it('forwards all four params together', async () => {
    const { proxyGet, calls } = makeCapturingStub({
      drafts: [],
      total: 7,
      nextCursor: null,
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    baseUrl = `http://${server.hostname}:${server.port}`

    await fetch(`${baseUrl}/api/proposals?source=reflection&status=draft&limit=10&cursor=20`)
    const daemonUrl = new URL(calls[0]!, 'http://stub')
    expect(daemonUrl.searchParams.get('source')).toBe('reflection')
    expect(daemonUrl.searchParams.get('status')).toBe('draft')
    expect(daemonUrl.searchParams.get('limit')).toBe('10')
    expect(daemonUrl.searchParams.get('cursor')).toBe('20')
  })

  it('includes total and nextCursor in the response', async () => {
    const { proxyGet } = makeCapturingStub({
      drafts: [],
      total: 1671,
      nextCursor: '50',
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/proposals?status=draft&limit=50`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ProposalsBody
    expect(body.total).toBe(1671)
    expect(body.nextCursor).toBe('50')
  })

  it('omits unknown params — does not forward arbitrary query params', async () => {
    const { proxyGet, calls } = makeCapturingStub({
      drafts: [],
      total: 0,
      nextCursor: null,
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet })
    baseUrl = `http://${server.hostname}:${server.port}`

    await fetch(`${baseUrl}/api/proposals?foo=bar&source=reflection`)
    const daemonUrl = new URL(calls[0]!, 'http://stub')
    // Only the declared params are forwarded
    expect(daemonUrl.searchParams.get('source')).toBe('reflection')
    expect(daemonUrl.searchParams.has('foo')).toBe(false)
  })
})
