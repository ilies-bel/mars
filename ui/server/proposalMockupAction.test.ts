/**
 * Tests for POST /api/actions — proposal.mockup operation.
 *
 * The ProposalDetailDrawer calls `postAction('proposal.mockup', proposal.id)`
 * which POSTs `{ op: 'proposal.mockup', entityId: '<id>' }` to the UI
 * server's /api/actions endpoint.  The server forwards this to
 * `proxyAction(stateDir, op, entityId)`, which in turn calls the daemon's
 * `/actions/proposal.mockup/<id>` route.
 *
 * This test stubs `proxyAction` (via ServerDeps) so no real daemon is needed.
 * It mirrors the shape of proposalsActions.test.ts.
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-proposal-mockup-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface ActionCall {
  op: string
  entityId: string | undefined
}

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

describe('POST /api/actions — proposal.mockup', () => {
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

  it('forwards proposal.mockup op + entityId to the daemon and returns taskId', async () => {
    const { proxyAction, calls } = makeActionStub({
      status: 200,
      body: { ok: true, taskId: 'mars-task-mockup-1' },
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyAction })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'proposal.mockup', entityId: 'prop-mockup-test' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; taskId: string }
    expect(body.ok).toBe(true)
    expect(body.taskId).toBe('mars-task-mockup-1')

    // Verify the stub was called with the correct arguments.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.op).toBe('proposal.mockup')
    expect(calls[0]!.entityId).toBe('prop-mockup-test')
  })

  it('propagates daemon error body so the drawer can display it', async () => {
    const { proxyAction } = makeActionStub({
      status: 500,
      body: { ok: false, error: 'proposal not found' },
    })
    server = await startServer({ repo, port: 0, host: '127.0.0.1' }, { proxyAction })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'proposal.mockup', entityId: 'prop-nonexistent' }),
    })

    expect(res.status).toBe(500)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('not found')
  })

  it('returns 400 when entityId is provided as a non-string (e.g. a number)', async () => {
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`

    const res = await fetch(`${baseUrl}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'proposal.mockup', entityId: 99 }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })
})
