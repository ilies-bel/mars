/**
 * Integration tests for the chat message feedback proxy routes in the UI server.
 *
 * The routes were missing from the UI server, causing `setMessageFeedback` and
 * `clearMessageFeedback` calls from the ChatPage to receive 404 instead of
 * forwarding to the daemon. The fix adds:
 *   POST /api/chat/messages/:id/feedback        → daemon POST /chat/messages/:id/feedback
 *   POST /api/chat/messages/:id/feedback/clear  → daemon POST /chat/messages/:id/feedback/clear
 *
 * These tests verify the routes are registered and reach the proxy layer. The
 * 503 (daemon unavailable) response — rather than 404 (route missing) — proves
 * the route is wired even without a running daemon. The daemon-level behaviour
 * (rating storage, 404-on-missing-message, etc.) is tested in
 * orchestrator/src/core/daemon/__tests__/http-chat-routes.test.ts.
 *
 * Also tests the grill-seeded thread path:
 *   POST /api/proposals/:id/thread              → creates a chat thread for grilling
 *   POST /api/chat/threads/:id/message          → posts a message to a grill-seeded thread
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { startServer } from './index.ts'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-chat-routes-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('POST /api/chat/messages/:id/feedback — proxy route registration', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    // No daemon started — the proxy will return 503, not 404.
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 503 (daemon unavailable) not 404 (route missing)', async () => {
    // With no daemon running the proxy returns 503 — proves the route is registered.
    // A 404 means the route was never matched (pre-fix behaviour).
    const res = await fetch(`${baseUrl}/api/chat/messages/msg-1/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 'up' }),
    })
    expect(res.status).toBe(503)
    expect(res.status).not.toBe(404)
  })
})

describe('POST /api/chat/messages/:id/feedback/clear — proxy route registration', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    // No daemon started — the proxy will return 503, not 404.
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 503 (daemon unavailable) not 404 (route missing)', async () => {
    // With no daemon running the proxy returns 503 — proves the route is registered.
    // A 404 means the route was never matched (pre-fix behaviour).
    const res = await fetch(`${baseUrl}/api/chat/messages/msg-1/feedback/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(503)
    expect(res.status).not.toBe(404)
  })
})

describe('POST /api/chat/threads/:id/delete', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 404 because the proxy route no longer exists', async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads/subject-1/delete`, {
      method: 'POST',
    })

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Grill-seeded thread: POST /api/proposals/:id/thread → POST /api/chat/threads/:id/message
//
// The proposal-drawer Grill button opens a chat thread via
// POST /api/proposals/:id/thread, then the composer POSTs messages via
// POST /api/chat/threads/:id/message. Both routes must be registered in the UI
// server so they reach the proxy layer even without a running daemon.
//
// A 500 (proxy error — daemon unavailable) on the proposal route and
// a 503 (daemon unavailable) on the message route prove the routes are wired.
// A 404 from either means the route was never matched (broken grill path).
// ---------------------------------------------------------------------------

describe('POST /api/proposals/:id/thread — grill thread creation route registration', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    // No daemon started — the proxy will fail reaching the daemon.
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns a non-404 response (route is registered, proxy fails without daemon)', async () => {
    // The route exists and tries to reach the daemon — without a daemon it
    // fails (500 or 503), but never returns 404 (which would mean unrouted).
    const res = await fetch(`${baseUrl}/api/proposals/proposal-1/thread`, {
      method: 'POST',
    })
    expect(res.status).not.toBe(404)
    // Route exists; daemon-unavailable errors manifest as 5xx.
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})

describe('POST /api/chat/threads/:id/message — grill-seeded thread send route registration', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    // No daemon started — the proxy will return 503, not 404.
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 503 (daemon unavailable) not 404 (route missing) for a grill-seeded thread id', async () => {
    // A grill-seeded thread has a UUID id (same format as any other thread).
    // The route /api/chat/threads/:id/message must proxy to the daemon — not 404.
    const grillThreadId = '17887eb9-80d2-4f55-979b-4fb517d2a7da'
    const res = await fetch(
      `${baseUrl}/api/chat/threads/${encodeURIComponent(grillThreadId)}/message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello from grill' }),
      },
    )
    expect(res.status).toBe(503)
    expect(res.status).not.toBe(404)
  })
})
