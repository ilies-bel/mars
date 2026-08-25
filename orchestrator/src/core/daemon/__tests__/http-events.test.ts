/**
 * Tests for GET /events — the unified event surface (ADR "Every seam is a
 * cordis service Port…" / "One typed event…", slice 5). Pin the per-task
 * filter (the slice-H caller), the cursor-paginated load-more contract the
 * actionQueue detail panel uses, and that a lifecycle kind written only via
 * `emitEvent` (bus/emit.ts) — previously reachable only through the durable
 * `events` outbox, never over HTTP — now round-trips through this route
 * alongside trace-only kinds.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { openDb, type DbClient } from '../../lib/db'
import { emitEvent } from '../../../bus/emit'
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
      continueTask: async () => {},
  remergeTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => ({ taskIds: [] }),
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
  // Same dbTarget as `store` — `openDb` dedupes onto the same pooled client,
  // so writes through `emitEvent(dbClient, ...)` land in the identical
  // `trace_events` table `store.query()` reads.
  let dbClient: DbClient

  beforeEach(async () => {
    dbDir = mkdtempSync(resolve(tmpdir(), 'mars-http-ev-'))
    mkdirSync(dbDir, { recursive: true })
    store = await openTraceEventStore(join(dbDir, 'mars.db'))
    dbClient = openDb(join(dbDir, 'mars.db'))
    // `emitEvent` without `opts.tx` opens its own transaction via
    // `withTransaction`, which — unlike `client.execute()` — bypasses the
    // lazy schema bootstrap (see db.ts's `ensureClientSchema` doc comment).
    // Warm the client with a plain query first so schema is guaranteed
    // ready before any test calls `emitEvent` directly.
    await dbClient.execute('SELECT 1')
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

  it('serves a formerly bus-only lifecycle kind written via emitEvent', async () => {
    // `task.completed` is a bus `EventName` (bus/events.ts) — before the
    // unified store, it was written only to the `events` outbox, never to
    // `trace_events`, so GET /events could never surface it. `emitEvent`
    // (bus/emit.ts) now writes it to trace_events too.
    await emitEvent(
      dbClient,
      'task.completed',
      { taskId: 'task-F', result: { ok: true } },
      { taskId: 'task-F' },
    )

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events?kind=task.completed`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { events: TraceEvent[]; nextCursor: string | null }
      expect(body.events).toHaveLength(1)
      const ev = body.events[0]!
      expect(ev.kind).toBe('task.completed')
      expect(ev.taskId).toBe('task-F')
      expect(ev.payload).toEqual({ taskId: 'task-F', result: { ok: true } })
    } finally {
      await close()
    }
  })

  it('mixes trace-only and formerly bus-only kinds for one task, paginating correctly', async () => {
    // A trace-only kind (already reachable pre-slice)...
    await store.record({
      kind: 'step_started',
      taskId: 'task-G',
      phase: 'code',
      payload: { stepName: 'code' },
    })
    // ...alongside two bus-only lifecycle kinds, written the unified way.
    await emitEvent(dbClient, 'task.queued', { taskId: 'task-G' }, { taskId: 'task-G' })
    await emitEvent(
      dbClient,
      'task.completed',
      { taskId: 'task-G', result: null },
      { taskId: 'task-G' },
    )

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const first = (await (
        await fetch(`http://127.0.0.1:${port}/events?taskId=task-G&limit=2`)
      ).json()) as { events: TraceEvent[]; nextCursor: string | null }
      expect(first.events).toHaveLength(2)
      expect(first.nextCursor).not.toBeNull()

      const second = (await (
        await fetch(
          `http://127.0.0.1:${port}/events?taskId=task-G&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
        )
      ).json()) as { events: TraceEvent[]; nextCursor: string | null }
      expect(second.events).toHaveLength(1)
      // Partial page → no further cursor.
      expect(second.nextCursor).toBeNull()

      // All three events — mixing trace-only and formerly bus-only kinds —
      // are returned across the two pages with no gaps or duplicates.
      const allEvents = [...first.events, ...second.events]
      expect(new Set(allEvents.map((e) => e.id)).size).toBe(3)
      expect(allEvents.map((e) => e.kind).sort()).toEqual(
        ['step_started', 'task.completed', 'task.queued'].sort(),
      )
      for (const e of allEvents) {
        expect(e.taskId).toBe('task-G')
      }
    } finally {
      await close()
    }
  })

  // Slice 8 (modular-core): verify output and provider/model attribution moved
  // onto the durable surface. `verify-attribution-events.test.ts` pins the
  // producer half (verifyChanges / runWorkerWithSpan → trace_events); this pins
  // the reader half at the real HTTP boundary, which is what the acceptance
  // criterion actually names: an operator auditing a finished task gets both
  // facts, payloads intact, from `GET /events?taskId=<id>` alone — no
  // transcript table is consulted by this route.
  it('returns verify output and model attribution for a finished task', async () => {
    await store.record({
      kind: 'worker.model.attributed',
      taskId: 'task-H',
      phase: 'code',
      payload: {
        workerName: 'Coder',
        stepName: 'run-claude-code',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        tier: 'balanced',
      },
    })
    await store.record({
      kind: 'verify.step.completed',
      taskId: 'task-H',
      phase: 'verify',
      payload: {
        step: 'typecheck',
        command: 'npm run typecheck',
        exitCode: 2,
        stdoutTail: 'error TS2345: Argument of type ...',
        stderrTail: '',
      },
    })

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const body = (await (
        await fetch(`http://127.0.0.1:${port}/events?taskId=task-H`)
      ).json()) as { events: TraceEvent[]; nextCursor: string | null }

      const verify = body.events.find((e) => e.kind === 'verify.step.completed')!
      expect(verify).toBeDefined()
      expect(verify.phase).toBe('verify')
      // The command and what it printed survive the round-trip through the
      // route — this is the whole point of the slice.
      expect(verify.payload).toMatchObject({
        step: 'typecheck',
        command: 'npm run typecheck',
        exitCode: 2,
        stdoutTail: 'error TS2345: Argument of type ...',
      })
      // A non-zero verify step is surfaced above the info floor.
      expect(verify.severity).toBe('warn')

      const attributed = body.events.find(
        (e) => e.kind === 'worker.model.attributed',
      )!
      expect(attributed).toBeDefined()
      expect(attributed.phase).toBe('code')
      expect(attributed.payload).toMatchObject({
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        tier: 'balanced',
      })
    } finally {
      await close()
    }
  })

  // Both kinds are independently filterable, so the actionQueue detail panel can
  // ask for "which model ran this" without paging through verify output.
  it('filters the new kinds independently via ?kind=', async () => {
    await store.record({
      kind: 'verify.step.completed',
      taskId: 'task-I',
      phase: 'verify',
      payload: {
        step: 'test',
        command: 'npm test',
        exitCode: 0,
        stdoutTail: 'ok',
        stderrTail: '',
      },
    })
    await store.record({
      kind: 'worker.model.attributed',
      taskId: 'task-I',
      phase: 'code',
      payload: {
        workerName: 'Coder',
        stepName: 'run-claude-code',
        provider: 'codex',
        model: 'gpt-5.6-terra',
        tier: 'balanced',
      },
    })

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const body = (await (
        await fetch(
          `http://127.0.0.1:${port}/events?taskId=task-I&kind=worker.model.attributed`,
        )
      ).json()) as { events: TraceEvent[]; nextCursor: string | null }
      expect(body.events).toHaveLength(1)
      expect(body.events[0]!.kind).toBe('worker.model.attributed')
      expect(body.events[0]!.payload).toMatchObject({ provider: 'codex' })
    } finally {
      await close()
    }
  })
})
