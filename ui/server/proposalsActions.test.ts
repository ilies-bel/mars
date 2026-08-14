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
