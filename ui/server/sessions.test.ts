/**
 * Tests for GET /api/sessions via the UI server.
 *
 * The endpoint returns sessions for a given Worker, derived from
 * step_started and step_ended trace events. A step_started with no
 * matching step_ended (same workflowInstanceId + stepName) is a live
 * running session; a step_ended is a finished session.
 */

import './__testing__/pgliteEnv.ts'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { openTraceEventStore } from '../../orchestrator/src/core/lib/trace-events-store.ts'
import { startServer } from './index.ts'
import { makeDaemonStub } from './testDaemonStub.ts'

interface WorkerSession {
  id: string
  sessionId: string | null
  workerName: string
  stepName: string
  workflowInstanceId: string
  outcome: string
  endedAt: string
  durationMs: number | null
}

interface SessionsBody {
  sessions: WorkerSession[]
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-sessions-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('GET /api/sessions', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string
  let dbPath: string

  beforeEach(async () => {
    repo = setupRepo()
    dbPath = resolve(repo, '.mars/mars.db')

    // Open the trace store once to create the schema, then close.
    const store = await openTraceEventStore(dbPath)
    await store.close()

    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: makeDaemonStub(repo) },
    )
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns an empty sessions array when no trace events exist', async () => {
    const res = await fetch(`${baseUrl}/api/sessions?agentName=Coder`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionsBody
    expect(Array.isArray(body.sessions)).toBe(true)
    expect(body.sessions).toEqual([])
  })

  it('returns 400 when agentName query param is missing', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`)
    expect(res.status).toBe(400)
  })

  it('returns a running session for a step_started with no corresponding step_ended', async () => {
    const store = await openTraceEventStore(dbPath)
    await store.record({
      kind: 'step_started',
      payload: {
        workerName: 'Coder',
        stepName: 'code',
        workflowInstanceId: 'wf-001',
        sessionId: 'sess-abc',
      },
    })
    await store.close()

    const res = await fetch(`${baseUrl}/api/sessions?agentName=Coder`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionsBody
    expect(body.sessions).toHaveLength(1)
    const s = body.sessions[0]!
    expect(s.outcome).toBe('running')
    expect(s.workerName).toBe('Coder')
    expect(s.stepName).toBe('code')
    expect(s.workflowInstanceId).toBe('wf-001')
    expect(s.sessionId).toBe('sess-abc')
    expect(s.durationMs).toBeNull()
  })

  it('returns a finished session for a step_ended, not duplicated', async () => {
    const store = await openTraceEventStore(dbPath)
    await store.record({
      kind: 'step_started',
      payload: {
        workerName: 'Coder',
        stepName: 'code',
        workflowInstanceId: 'wf-002',
        sessionId: 'sess-xyz',
      },
    })
    await store.record({
      kind: 'step_ended',
      payload: {
        workerName: 'Coder',
        stepName: 'code',
        workflowInstanceId: 'wf-002',
        sessionId: 'sess-xyz',
        outcome: 'completed',
        durationMs: 12345,
      },
    })
    await store.close()

    const res = await fetch(`${baseUrl}/api/sessions?agentName=Coder`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionsBody
    // Only the finished session — the running one should NOT appear because
    // step_ended closes it.
    expect(body.sessions).toHaveLength(1)
    const s = body.sessions[0]!
    expect(s.outcome).toBe('completed')
    expect(s.durationMs).toBe(12345)
  })

  it('returns both a running and a finished session when both are present', async () => {
    const store = await openTraceEventStore(dbPath)
    // Finished session
    await store.record({
      kind: 'step_started',
      payload: {
        workerName: 'Coder',
        stepName: 'code',
        workflowInstanceId: 'wf-done',
        sessionId: 'sess-done',
      },
    })
    await store.record({
      kind: 'step_ended',
      payload: {
        workerName: 'Coder',
        stepName: 'code',
        workflowInstanceId: 'wf-done',
        sessionId: 'sess-done',
        outcome: 'completed',
        durationMs: 5000,
      },
    })
    // Running session
    await store.record({
      kind: 'step_started',
      payload: {
        workerName: 'Coder',
        stepName: 'code',
        workflowInstanceId: 'wf-live',
        sessionId: 'sess-live',
      },
    })
    await store.close()

    const res = await fetch(`${baseUrl}/api/sessions?agentName=Coder`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionsBody
    expect(body.sessions).toHaveLength(2)
    const outcomes = body.sessions.map((s) => s.outcome)
    expect(outcomes).toContain('running')
    expect(outcomes).toContain('completed')
  })

  it('only returns sessions for the requested worker, not other workers', async () => {
    const store = await openTraceEventStore(dbPath)
    await store.record({
      kind: 'step_started',
      payload: {
        workerName: 'Coder',
        stepName: 'code',
        workflowInstanceId: 'wf-coder',
      },
    })
    await store.record({
      kind: 'step_ended',
      payload: {
        workerName: 'Fixer',
        stepName: 'recover',
        workflowInstanceId: 'wf-fixer',
        outcome: 'failed',
        durationMs: 1000,
      },
    })
    await store.close()

    const res = await fetch(`${baseUrl}/api/sessions?agentName=Coder`)
    const body = (await res.json()) as SessionsBody
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]!.workerName).toBe('Coder')
  })

  it('returns sessions newest-first', async () => {
    const store = await openTraceEventStore(dbPath)
    // Insert three step_ended events so we can check ordering.
    for (const wfId of ['wf-a', 'wf-b', 'wf-c']) {
      await store.record({
        kind: 'step_ended',
        payload: {
          workerName: 'Fixer',
          stepName: 'recover',
          workflowInstanceId: wfId,
          outcome: 'completed',
          durationMs: 500,
        },
      })
    }
    await store.close()

    const res = await fetch(`${baseUrl}/api/sessions?agentName=Fixer`)
    const body = (await res.json()) as SessionsBody
    expect(body.sessions).toHaveLength(3)
    // Verify newest-first: endedAt of each row must be >= the next row's.
    for (let i = 1; i < body.sessions.length; i++) {
      expect(body.sessions[i - 1]!.endedAt >= body.sessions[i]!.endedAt).toBe(
        true,
      )
    }
  })
})
