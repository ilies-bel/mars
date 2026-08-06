/**
 * Tests for GET /view/sessions?agentName=<name> — the session feed derived
 * from step_started / step_ended trace events.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import {
  openTraceEventStore,
  type TraceEventStore,
} from '../../lib/trace-events-store'
import { buildSessionsView } from '../view/sessions'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-sess-rec-')),
  )
})

const makeDeps = (
  store: TraceEventStore,
  overrides: Partial<HttpServerDeps> = {},
): HttpServerDeps => ({
  restartTask: async () => {},
  remergeTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => {},
  validateTask: async () => {},
  rejectTask: async () => {},
  landWork: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }),
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},

  runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {},
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: store,
  appServices: stubAppServices({
    viewSessions: (agentName: string) => buildSessionsView(store, agentName),
  }),
  chatRunner: stubChatRunner(),
  ...overrides,
})

describe('GET /view/sessions', () => {
  let dbDir: string
  let store: TraceEventStore

  beforeEach(async () => {
    dbDir = mkdtempSync(resolve(tmpdir(), 'mars-http-sess-'))
    mkdirSync(dbDir, { recursive: true })
    store = await openTraceEventStore(join(dbDir, 'mars.db'))
  })

  afterEach(async () => {
    await store.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('returns 400 when agentName query parameter is missing', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/sessions`)
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toMatch(/agentName/)
    } finally {
      await close()
    }
  })

  it('returns empty sessions list when no trace events exist', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/sessions?agentName=coder`,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sessions).toEqual([])
    } finally {
      await close()
    }
  })

  it('returns a running session when step_started has no matching step_ended', async () => {
    await store.record({
      kind: 'step_started',
      taskId: 'task-1',
      phase: 'code',
      payload: {
        workerName: 'coder',
        stepName: 'code',
        workflowInstanceId: 'wf-1',
        sessionId: 'sess-1',
      },
    })

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/sessions?agentName=coder`,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sessions).toHaveLength(1)
      const s = body.sessions[0]
      expect(s.outcome).toBe('running')
      expect(s.sessionId).toBe('sess-1')
      expect(s.workerName).toBe('coder')
      expect(s.stepName).toBe('code')
      expect(s.workflowInstanceId).toBe('wf-1')
      expect(s.durationMs).toBeNull()
    } finally {
      await close()
    }
  })

  it('returns a finished session when step_ended exists', async () => {
    await store.record({
      kind: 'step_started',
      taskId: 'task-1',
      phase: 'code',
      payload: {
        workerName: 'coder',
        stepName: 'code',
        workflowInstanceId: 'wf-2',
        sessionId: 'sess-2',
      },
    })
    await store.record({
      kind: 'step_ended',
      taskId: 'task-1',
      phase: 'code',
      payload: {
        workerName: 'coder',
        stepName: 'code',
        workflowInstanceId: 'wf-2',
        sessionId: 'sess-2',
        outcome: 'success',
        durationMs: 1234,
      },
    })

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/sessions?agentName=coder`,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      // Only the step_ended row appears; step_started is suppressed because
      // its (workflowInstanceId, stepName) pair is closed.
      const finished = body.sessions.filter(
        (s: { outcome: string }) => s.outcome !== 'running',
      )
      expect(finished).toHaveLength(1)
      expect(finished[0].outcome).toBe('success')
      expect(finished[0].durationMs).toBe(1234)
      expect(finished[0].sessionId).toBe('sess-2')
    } finally {
      await close()
    }
  })

  it('does not include sessions for a different agentName', async () => {
    await store.record({
      kind: 'step_started',
      taskId: 'task-1',
      phase: 'code',
      payload: {
        workerName: 'fixer',
        stepName: 'code',
        workflowInstanceId: 'wf-fixer',
      },
    })

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/sessions?agentName=coder`,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      // coder has no events; the fixer event must not bleed through.
      expect(body.sessions).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('returns sessions sorted newest-first', async () => {
    await store.record({
      kind: 'step_ended',
      taskId: 'task-1',
      phase: 'code',
      payload: {
        workerName: 'coder',
        stepName: 'code',
        workflowInstanceId: 'wf-a',
        outcome: 'success',
        durationMs: 100,
      },
    })
    await store.record({
      kind: 'step_ended',
      taskId: 'task-2',
      phase: 'code',
      payload: {
        workerName: 'coder',
        stepName: 'code',
        workflowInstanceId: 'wf-b',
        outcome: 'success',
        durationMs: 200,
      },
    })

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/sessions?agentName=coder`,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sessions).toHaveLength(2)
      // Verify the list is in non-ascending endedAt order (newest-first).
      const [first, second] = body.sessions as Array<{ endedAt: string }>
      expect(first.endedAt.localeCompare(second.endedAt)).toBeGreaterThanOrEqual(0)
    } finally {
      await close()
    }
  })
})
