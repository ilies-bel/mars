/**
 * Tests for GET /events — the unified trace-event surface. Pin the
 * per-task filter (the slice-H caller) and the cursor-paginated
 * load-more contract that the actionQueue detail panel uses.
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
  type TraceEvent,
  type TraceEventStore,
} from '../../lib/trace-events-store'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-ev-rec-')),
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
  recipeCatalog:
    cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: store,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

describe('GET /events', () => {
  let dbDir: string
  let store: TraceEventStore

  beforeEach(async () => {
    dbDir = mkdtempSync(resolve(tmpdir(), 'mars-http-ev-'))
    mkdirSync(dbDir, { recursive: true })
    store = await openTraceEventStore(join(dbDir, 'mars.db'))
  })

  afterEach(async () => {
    await store.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('returns events filtered by taskId, newest first', async () => {
    // Two tasks; only one matches the filter.
    await store.record({
      kind: 'step_started',
      taskId: 'task-A',
      phase: 'setup',
      payload: { stepName: 'setup' },
    })
    await store.record({
      kind: 'step_ended',
      taskId: 'task-A',
      phase: 'setup',
      payload: { stepName: 'setup', outcome: 'success' },
    })
    await store.record({
      kind: 'tool_invoked',
      taskId: 'task-B',
      phase: 'code',
      payload: { tool: 'git', argv: ['status'], exitCode: 0 },
    })

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events?taskId=task-A`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        events: TraceEvent[]
        nextCursor: string | null
      }
      expect(body.events).toHaveLength(2)
      // Newest-first ordering: step_ended (the later insert) comes first.
      expect(body.events[0]!.kind).toBe('step_ended')
      expect(body.events[1]!.kind).toBe('step_started')
      // Both rows are for task-A only.
      for (const e of body.events) {
        expect(e.taskId).toBe('task-A')
      }
      // Page is not full (limit defaults to 200) → no cursor.
      expect(body.nextCursor).toBeNull()
    } finally {
      await close()
    }
  })

  it('paginates via cursor when the page is full', async () => {
    for (let i = 0; i < 5; i++) {
      await store.record({
        kind: 'tool_invoked',
        taskId: 'task-C',
        phase: 'code',
        payload: { tool: 'git', argv: ['log'], exitCode: 0, i },
      })
    }

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      // Page size of 2 → 3 pages: 2 rows + 2 rows + 1 row.
      const first = (await (
        await fetch(`http://127.0.0.1:${port}/events?taskId=task-C&limit=2`)
      ).json()) as { events: TraceEvent[]; nextCursor: string | null }
      expect(first.events).toHaveLength(2)
      expect(first.nextCursor).not.toBeNull()

      const second = (await (
        await fetch(
          `http://127.0.0.1:${port}/events?taskId=task-C&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
        )
      ).json()) as { events: TraceEvent[]; nextCursor: string | null }
      expect(second.events).toHaveLength(2)
      expect(second.nextCursor).not.toBeNull()

      const third = (await (
        await fetch(
          `http://127.0.0.1:${port}/events?taskId=task-C&limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`,
        )
      ).json()) as { events: TraceEvent[]; nextCursor: string | null }
      expect(third.events).toHaveLength(1)
      // Partial page → no further cursor.
      expect(third.nextCursor).toBeNull()

      // Page boundaries do not overlap.
      const allIds = [
        ...first.events.map((e) => e.id),
        ...second.events.map((e) => e.id),
        ...third.events.map((e) => e.id),
      ]
      expect(new Set(allIds).size).toBe(5)
    } finally {
      await close()
    }
  })

  it('substring filter `q` matches the JSON-serialized payload', async () => {
    await store.record({
      kind: 'tool_invoked',
      taskId: 'task-D',
      phase: 'code',
      payload: { tool: 'jest', argv: ['--ci'], exitCode: 1 },
    })
    await store.record({
      kind: 'tool_invoked',
      taskId: 'task-D',
      phase: 'verify',
      payload: { tool: 'tsc', argv: ['--noEmit'], exitCode: 0 },
    })

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events?q=tsc`)
      const body = (await res.json()) as { events: TraceEvent[] }
      expect(body.events).toHaveLength(1)
      expect(body.events[0]!.payload.tool).toBe('tsc')
    } finally {
      await close()
    }
  })

  it('?kind=log_line returns log_line events with full payload intact', async () => {
    // Record a log_line event and a non-log_line event side by side.
    await store.record({
      kind: 'log_line',
      taskId: 'task-E',
      phase: null,
      payload: {
        level: 'warn',
        msg: 'connection retry',
        source: 'daemon',
        fields: { attempt: 3, host: 'localhost' },
      },
    })
    await store.record({
      kind: 'step_started',
      taskId: 'task-E',
      phase: 'code',
      payload: { stepName: 'code' },
    })

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events?kind=log_line`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: TraceEvent[]; nextCursor: string | null }
      // Only the log_line event is returned.
      expect(body.events).toHaveLength(1)
      const ev = body.events[0]!
      expect(ev.kind).toBe('log_line')
      // Payload fields round-trip intact through the JSON response.
      expect(ev.payload.level).toBe('warn')
      expect(ev.payload.msg).toBe('connection retry')
      expect(ev.payload.source).toBe('daemon')
      expect(ev.payload.fields).toEqual({ attempt: 3, host: 'localhost' })
    } finally {
      await close()
    }
  })
})
