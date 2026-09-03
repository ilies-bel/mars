/**
 * Tests for POST /api/actions — proposal promote and dismiss operations
 * exercised through the UI server's /api/actions endpoint.
 *
 * The test injects a `proxyAction` stub (via ServerDeps) so no real daemon is
 * needed. This verifies the payload routing (op + entityId → daemon call) and
 * the error-surfacing contract (daemon 4xx/5xx body is forwarded to the
 * caller so the drawer can show it instead of a generic "POST /api/actions → N").
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DaemonActionResult } from './daemonHttp.ts'
import { startServer } from './index.ts'

// Re-exported for the proposal-thread describe block below.
interface ProxyPostCall {
  path: string
  body: unknown
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-proposal-actions-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface ActionCall {
  op: string
  entityId: string | undefined
}

/** Build a proxyAction stub that records calls and returns a preset body. */
const makeActionStub = (
  response: DaemonActionResult,
): {
  proxyAction: (stateDir: string, op: string, entityId?: string) => Promise<DaemonActionResult>
  calls: ActionCall[]
} => {
  const calls: ActionCall[] = []
  return {
    calls,
    proxyAction: async (_stateDir, op, entityId) => {
      calls.push({ op, entityId })
      return response
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/actions — proposal promote', () => {
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

  it('forwards promote op + entityId to the daemon and returns ok + taskIds', async () => {
    const { proxyAction, calls } = makeActionStub({
      status: 200,
      body: { ok: true, taskIds: ['mars-task-abc', 'mars-task-def'] },
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyAction })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'promote', entityId: 'prop-74d76a78' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; taskIds: string[] }
    expect(body.ok).toBe(true)
    expect(body.taskIds).toEqual(['mars-task-abc', 'mars-task-def'])

    // Verify the stub was called with the correct arguments.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.op).toBe('promote')
    expect(calls[0]!.entityId).toBe('prop-74d76a78')
  })

  it('returns 400 when op is missing (malformed payload)', async () => {
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`

    // Send payload without 'op' (the field the drawer would have sent before
    // the bug was fixed — e.g. { action: 'promote', id: '...' }).
    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'promote', id: 'prop-abc' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    // The error body must be a string the drawer can surface to the user.
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('returns 400 when entityId is not a string', async () => {
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'promote', entityId: 42 }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('propagates daemon error body so the drawer can display it', async () => {
    // Daemon returns a meaningful error; the UI server must forward it verbatim
    // so the drawer's error state shows the real message rather than a generic
    // "POST /api/actions → 500" fallback.
    const { proxyAction } = makeActionStub({
      status: 500,
      body: { ok: false, error: 'proposal is not in draft status' },
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyAction })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'promote', entityId: 'prop-already-prd-ready' }),
    })

    expect(res.status).toBe(500)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('not in draft status')
  })
})

describe('POST /api/actions — proposal dismiss', () => {
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

  it('forwards dismiss op + entityId to the daemon and returns ok', async () => {
    const { proxyAction, calls } = makeActionStub({
      status: 200,
      body: { ok: true },
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyAction })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'dismiss', entityId: 'prop-74d76a78' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.op).toBe('dismiss')
    expect(calls[0]!.entityId).toBe('prop-74d76a78')
  })

  it('propagates daemon error body for dismiss so the drawer can display it', async () => {
    const { proxyAction } = makeActionStub({
      status: 500,
      body: { ok: false, error: 'cannot be dismissed: has dependent tasks' },
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyAction })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'dismiss', entityId: 'prop-has-dependents' }),
    })

    expect(res.status).toBe(500)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('dependent tasks')
  })
})

// ---------------------------------------------------------------------------
// POST /api/proposals/:id/thread — grill thread with seeded context message
// ---------------------------------------------------------------------------

/**
 * Build a paired proxyGet + proxyPost stub for the proposal-thread handler.
 *
 * proxyGet always returns the supplied `proposal` for any path that looks like
 * /view/proposal/:id, and 404 otherwise (so stale-daemon-code detection in the
 * withSkewDetection wrapper falls through harmlessly).
 *
 * proxyPost records every call and dispatches by path:
 *   /chat/threads          → returns { id: 'thread-seed-001' }
 *   /chat/threads/:id/message → returns the supplied seedResult (default 200)
 */
const makeProposalThreadStubs = (
  proposal: {
    title?: string
    problem?: string
    solution?: string
    userStories?: string[]
    outOfScope?: string
  },
  seedResult: DaemonActionResult = { status: 200, body: { ok: true } },
): {
  proxyGet: (stateDir: string, path: string) => Promise<DaemonActionResult>
  proxyPost: (stateDir: string, path: string, body: unknown) => Promise<DaemonActionResult>
  postCalls: ProxyPostCall[]
} => {
  const postCalls: ProxyPostCall[] = []
  return {
    postCalls,
    proxyGet: async (_stateDir, path) => {
      if (path.startsWith('/view/proposal/')) {
        return { status: 200, body: proposal }
      }
      return { status: 404, body: { error: `stub: unhandled GET ${path}` } }
    },
    proxyPost: async (_stateDir, path, body) => {
      postCalls.push({ path, body })
      if (path === '/chat/threads') {
        return { status: 200, body: { id: 'thread-seed-001' } }
      }
      if (path.startsWith('/chat/threads/') && path.endsWith('/message')) {
        return seedResult
      }
      return { status: 404, body: { error: `stub: unhandled POST ${path}` } }
    },
  }
}

describe('POST /api/proposals/:id/thread — seed message', () => {
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

  it('creates thread with title "Grill: <title>" and posts seed message', async () => {
    const { proxyGet, proxyPost, postCalls } = makeProposalThreadStubs({
      title: 'Better alerts UX',
      problem: 'Alerts are hard to find.',
      solution: 'Surface them in the sidebar.',
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet, proxyPost })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/proposals/prop-abc/thread`, { method: 'POST' })
    expect(res.status).toBe(200)
    const resBody = (await res.json()) as { threadId: string }
    expect(resBody.threadId).toBe('thread-seed-001')

    // Thread creation call
    const createCall = postCalls.find(c => c.path === '/chat/threads')
    expect(createCall).toBeDefined()
    expect((createCall!.body as { title: string }).title).toBe('Grill: Better alerts UX')

    // Seed message call
    const seedCall = postCalls.find(c => c.path.endsWith('/message'))
    expect(seedCall).toBeDefined()
    const seedBody = seedCall!.body as { role: string; content: string }
    expect(seedBody.role).toBe('context')
    expect(seedBody.content).toContain('## Problem')
    expect(seedBody.content).toContain('Alerts are hard to find.')
    expect(seedBody.content).toContain('## Solution')
    expect(seedBody.content).toContain('Surface them in the sidebar.')
  })

  it('omits empty sections from the seed message', async () => {
    const { proxyGet, proxyPost, postCalls } = makeProposalThreadStubs({
      title: 'Minimal proposal',
      problem: 'The only non-empty field.',
      solution: '',         // empty → omitted
      outOfScope: '   ',   // whitespace-only → omitted
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet, proxyPost })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/proposals/prop-min/thread`, { method: 'POST' })
    expect(res.status).toBe(200)

    const seedCall = postCalls.find(c => c.path.endsWith('/message'))
    expect(seedCall).toBeDefined()
    const content = (seedCall!.body as { content: string }).content
    expect(content).toContain('## Problem')
    expect(content).not.toContain('## Solution')
    expect(content).not.toContain('## Out of Scope')
  })

  it('includes numbered user stories when present', async () => {
    const { proxyGet, proxyPost, postCalls } = makeProposalThreadStubs({
      title: 'Stories proposal',
      problem: 'Need stories.',
      solution: 'Add them.',
      userStories: ['As a user I can view alerts', 'As a user I can dismiss alerts'],
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet, proxyPost })
    baseUrl = `http://${server.hostname}:${server.port}`

    await fetch(`${baseUrl}/api/proposals/prop-stories/thread`, { method: 'POST' })

    const seedCall = postCalls.find(c => c.path.endsWith('/message'))
    expect(seedCall).toBeDefined()
    const content = (seedCall!.body as { content: string }).content
    expect(content).toContain('## User Stories')
    expect(content).toContain('1. As a user I can view alerts')
    expect(content).toContain('2. As a user I can dismiss alerts')
  })

  it('includes out-of-scope section when non-empty', async () => {
    const { proxyGet, proxyPost, postCalls } = makeProposalThreadStubs({
      title: 'Scoped proposal',
      problem: 'Scope it.',
      outOfScope: 'No mobile support.',
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet, proxyPost })
    baseUrl = `http://${server.hostname}:${server.port}`

    await fetch(`${baseUrl}/api/proposals/prop-scope/thread`, { method: 'POST' })

    const seedCall = postCalls.find(c => c.path.endsWith('/message'))
    expect(seedCall).toBeDefined()
    const content = (seedCall!.body as { content: string }).content
    expect(content).toContain('## Out of Scope')
    expect(content).toContain('No mobile support.')
  })

  it('still returns { threadId } when all sections are empty (no seed posted)', async () => {
    // A proposal with no meaningful content should still open a thread.
    const { proxyGet, proxyPost, postCalls } = makeProposalThreadStubs({
      title: 'Empty body',
      problem: '',
      solution: '',
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet, proxyPost })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/proposals/prop-empty/thread`, { method: 'POST' })
    expect(res.status).toBe(200)
    const resBody = (await res.json()) as { threadId: string }
    expect(resBody.threadId).toBe('thread-seed-001')

    // No seed message should have been posted
    const seedCall = postCalls.find(c => c.path.endsWith('/message'))
    expect(seedCall).toBeUndefined()
  })

  it('returns { threadId } even when the seed message post fails', async () => {
    // Seed failures are swallowed — the thread is still usable.
    const { proxyGet, proxyPost } = makeProposalThreadStubs(
      { title: 'Resilient proposal', problem: 'Something.' },
      { status: 500, body: { error: 'daemon exploded' } },
    )
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyGet, proxyPost })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/proposals/prop-fail/thread`, { method: 'POST' })
    expect(res.status).toBe(200)
    const resBody = (await res.json()) as { threadId: string }
    expect(resBody.threadId).toBe('thread-seed-001')
  })
})
