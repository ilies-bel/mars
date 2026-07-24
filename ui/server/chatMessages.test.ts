/**
 * Integration tests for the chat-message feedback proxy routes.
 *
 * POST /api/chat/messages/:id/feedback        → daemon /chat/messages/:id/feedback
 * POST /api/chat/messages/:id/feedback/clear  → daemon /chat/messages/:id/feedback/clear
 *
 * These routes were missing, causing the thumbs-up/down UI to 404. Verified
 * here that both paths reach the correct daemon endpoint, pass the request body
 * through, and relay the daemon's status/body verbatim.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startServer } from './index.ts'
import type { DaemonActionResult } from './daemonHttp.ts'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-chat-messages-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface ProxyPostCall {
  stateDir: string
  path: string
  body: unknown
  method: string | undefined
}

/** Stub proxyPost that records calls and returns the configured response. */
const makeProxyPostStub = (
  response: DaemonActionResult,
): {
  stub: (stateDir: string, path: string, body: unknown, method?: 'POST' | 'PUT') => Promise<DaemonActionResult>
  calls: ProxyPostCall[]
} => {
  const calls: ProxyPostCall[] = []
  return {
    calls,
    stub: async (stateDir, path, body, method) => {
      calls.push({ stateDir, path, body, method })
      return response
    },
  }
}

/** Minimal proxyGet stub that handles no paths (chat messages routes don't use it). */
const noopProxyGet = async (
  _stateDir: string,
  path: string,
): Promise<DaemonActionResult> => ({
  status: 404,
  body: { error: `stub: unhandled ${path}` },
})

describe('POST /api/chat/messages/:id/feedback', () => {
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

  it('forwards to the daemon /chat/messages/:id/feedback and relays status+body', async () => {
    const { stub, calls } = makeProxyPostStub({ status: 200, body: { ok: true } })
    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: noopProxyGet, proxyPost: stub },
    )
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/chat/messages/msg-abc/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 1 }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/chat/messages/msg-abc/feedback')
    expect(calls[0].body).toEqual({ rating: 1 })
  })

  it('URL-decodes the message id and re-encodes it for the daemon', async () => {
    const { stub, calls } = makeProxyPostStub({ status: 200, body: {} })
    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: noopProxyGet, proxyPost: stub },
    )
    baseUrl = `http://${server.hostname}:${server.port}`

    await fetch(
      `${baseUrl}/api/chat/messages/${encodeURIComponent('thread/msg 1')}/feedback`,
      { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
    )

    expect(calls).toHaveLength(1)
    // The daemon path should have the id re-encoded
    expect(calls[0].path).toBe(
      `/chat/messages/${encodeURIComponent('thread/msg 1')}/feedback`,
    )
  })

  it('relays a non-200 daemon status', async () => {
    const { stub } = makeProxyPostStub({ status: 422, body: { error: 'invalid rating' } })
    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: noopProxyGet, proxyPost: stub },
    )
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/chat/messages/msg-xyz/feedback`, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    })

    expect(res.status).toBe(422)
  })

  it('returns 400 when the message id is empty', async () => {
    const { stub, calls } = makeProxyPostStub({ status: 200, body: {} })
    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: noopProxyGet, proxyPost: stub },
    )
    baseUrl = `http://${server.hostname}:${server.port}`

    // Path is /api/chat/messages//feedback — empty id segment
    const res = await fetch(`${baseUrl}/api/chat/messages//feedback`, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    })

    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('POST /api/chat/messages/:id/feedback/clear', () => {
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

  it('forwards to the daemon /chat/messages/:id/feedback/clear and relays status+body', async () => {
    const { stub, calls } = makeProxyPostStub({ status: 200, body: { cleared: true } })
    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: noopProxyGet, proxyPost: stub },
    )
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/chat/messages/msg-abc/feedback/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { cleared: boolean }
    expect(body.cleared).toBe(true)

    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/chat/messages/msg-abc/feedback/clear')
  })

  it('does NOT match the plain /feedback route (ordering: /clear checked first)', async () => {
    const { stub, calls } = makeProxyPostStub({ status: 200, body: {} })
    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: noopProxyGet, proxyPost: stub },
    )
    baseUrl = `http://${server.hostname}:${server.port}`

    await fetch(`${baseUrl}/api/chat/messages/msg-abc/feedback/clear`, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    })

    expect(calls).toHaveLength(1)
    // Must route to /feedback/clear, NOT /feedback
    expect(calls[0].path).toContain('/feedback/clear')
    expect(calls[0].path).not.toBe('/chat/messages/msg-abc/feedback')
  })

  it('relays body from the request to the daemon', async () => {
    const { stub, calls } = makeProxyPostStub({ status: 200, body: {} })
    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: noopProxyGet, proxyPost: stub },
    )
    baseUrl = `http://${server.hostname}:${server.port}`

    await fetch(`${baseUrl}/api/chat/messages/msg-1/feedback/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'mistake' }),
    })

    expect(calls[0].body).toEqual({ reason: 'mistake' })
  })
})
