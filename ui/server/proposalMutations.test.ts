/**
 * Tests for POST /api/actions body-forwarding behaviour (slice 4: proposal
 * mutation endpoints).
 *
 * The UI server's /api/actions handler must:
 *   1. Extract op + entityId from the request body as before.
 *   2. Forward any additional body keys (field/value, story, index …) to
 *      proxyAction as an optional `body` argument.
 *   3. Pass `undefined` (not an empty object) when there are no extra keys,
 *      so callers that send only {op, entityId} are unchanged.
 *
 * A proxyAction stub records calls including the forwarded body so we can
 * assert forwarding without starting a real daemon.
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-proposal-mut-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface ActionCall {
  op: string
  entityId: string | undefined
  body: Record<string, unknown> | undefined
}

/** Build a proxyAction stub that records calls and returns a preset response. */
const makeActionStub = (
  response: DaemonActionResult,
): {
  proxyAction: (
    stateDir: string,
    op: string,
    entityId?: string,
    body?: Record<string, unknown>,
  ) => Promise<DaemonActionResult>
  calls: ActionCall[]
} => {
  const calls: ActionCall[] = []
  return {
    calls,
    proxyAction: async (_stateDir, op, entityId, body) => {
      calls.push({ op, entityId, body })
      return response
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/actions — body forwarding for proposal mutation ops', () => {
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

  it('forwards field + value to proxyAction for proposal.set-field', async () => {
    const { proxyAction, calls } = makeActionStub({ status: 200, body: { ok: true } })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyAction })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'proposal.set-field',
        entityId: 'prop-abc',
        field: 'title',
        value: 'Updated title',
      }),
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.op).toBe('proposal.set-field')
    expect(calls[0]!.entityId).toBe('prop-abc')
    expect(calls[0]!.body).toEqual({ field: 'title', value: 'Updated title' })
  })

  it('forwards story to proxyAction for proposal.add-story', async () => {
    const { proxyAction, calls } = makeActionStub({
      status: 200,
      body: { ok: true, id: '0' },
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyAction })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'proposal.add-story',
        entityId: 'prop-xyz',
        story: 'As a user I can do X',
      }),
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.op).toBe('proposal.add-story')
    expect(calls[0]!.entityId).toBe('prop-xyz')
    expect(calls[0]!.body).toEqual({ story: 'As a user I can do X' })
  })

  it('forwards index to proxyAction for proposal.remove-story', async () => {
    const { proxyAction, calls } = makeActionStub({ status: 200, body: { ok: true } })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyAction })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'proposal.remove-story',
        entityId: 'prop-abc',
        index: 2,
      }),
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.op).toBe('proposal.remove-story')
    expect(calls[0]!.entityId).toBe('prop-abc')
    expect(calls[0]!.body).toEqual({ index: 2 })
  })

  it('passes undefined body for proposal.delete (no extra keys)', async () => {
    const { proxyAction, calls } = makeActionStub({ status: 200, body: { ok: true } })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyAction })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'proposal.delete', entityId: 'prop-del' }),
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.op).toBe('proposal.delete')
    expect(calls[0]!.entityId).toBe('prop-del')
    // No extra keys → body should be undefined, not {}
    expect(calls[0]!.body).toBeUndefined()
  })

  it('passes undefined body when op has no extra params (existing behavior unchanged)', async () => {
    const { proxyAction, calls } = makeActionStub({ status: 200, body: { ok: true } })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyAction })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'dismiss', entityId: 'prop-abc' }),
    })

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toBeUndefined()
  })

  it('propagates daemon error body for proposal.set-field so the UI can display it', async () => {
    const { proxyAction } = makeActionStub({
      status: 422,
      body: { ok: false, error: "invalid field 'bogus-field'" },
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyAction })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'proposal.set-field',
        entityId: 'prop-abc',
        field: 'bogus-field',
        value: 'x',
      }),
    })

    expect(res.status).toBe(422)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('bogus-field')
  })
})
