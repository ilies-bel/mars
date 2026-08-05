/**
 * Unit tests for the viewPrimitives / viewPrimitive projections in
 * AppServices — the read layer behind GET /view/primitives[/:name].
 *
 * Mirrors view-run-timeline.test.ts: a real TraceEventStore backed by a temp
 * SQLite file so the full phase-filtered query/pairing path executes, with
 * trace rows inserted via direct SQL and explicit ISO-8601 timestamps for
 * deterministic ordering. The registry and parks reads are injected through
 * AppServicesDeps so assertions never depend on the host repo's
 * `.mars/worker-registry.json` or action-queue DB.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTraceEventStore, deriveSeverity, type TraceEventStore } from '../trace-events-store'
import { openLibsql } from '../libsql'
import type { Client } from '@libsql/client'
import { createAppServices } from '../../app-services'
import type { AppServices, AppServicesDeps } from '../../app-services'
import {
  BEHAVIOUR_VERIFY_SPAN_STEP_NAME,
  PRIMITIVE_NAMES,
  primitiveForSpan,
} from '../primitive-catalog'
import { BEHAVIOUR_VERIFY_STEP_NAME } from '../../../workflows/primitives/behaviour-verify'
import { FIXER_BACKLOG_DENIED_TOOLS, READ_ONLY_DENIED_TOOLS } from '../../workers'
import type { WorkerDeclaration } from '../../workers/persisted-registry'
import type { PrimitivePark } from '../../daemon/http-server'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-view-primitives-'))
  return join(dir, 'mars.db')
}

/** Build an AppServices over the trace store with deterministic injected reads. */
const makeServices = (
  traceStore: TraceEventStore,
  overrides: Partial<AppServicesDeps> = {},
): AppServices =>
  createAppServices({
    traceStore,
    buildAlertSources: async () => ({
      listFailedArcs: async () => [],
      listStaleWorktrees: async () => [],
      listVerifyUncovered: async () => [],
    }),
    loadWorkerDeclarations: () => [],
    listAwaitingHumanParks: async () => [],
    ...overrides,
  })

type Phase = 'setup' | 'code' | 'verify' | 'merge'

const insertStarted = async (
  client: Client,
  opts: {
    taskId: string
    workflowInstanceId: string
    stepName: string
    timestamp: string
    phase: Phase
    workerName?: string
  },
): Promise<void> => {
  const payload: Record<string, unknown> = {
    stepName: opts.stepName,
    workflowInstanceId: opts.workflowInstanceId,
  }
  if (opts.workerName) payload.workerName = opts.workerName
  await client.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
          VALUES (?, ?, 'step_started', 'info', ?, NULL, ?, ?)`,
    args: [randomUUID(), Date.parse(opts.timestamp), opts.taskId, opts.phase, JSON.stringify(payload)],
  })
}

const insertEnded = async (
  client: Client,
  opts: {
    taskId: string
    workflowInstanceId: string
    stepName: string
    timestamp: string
    phase: Phase
    outcome?: 'completed' | 'failed' | 'killed'
    durationMs?: number
    sessionId?: string
  },
): Promise<void> => {
  const payload: Record<string, unknown> = {
    stepName: opts.stepName,
    workflowInstanceId: opts.workflowInstanceId,
    outcome: opts.outcome ?? 'completed',
    durationMs: opts.durationMs ?? 100,
  }
  if (opts.sessionId !== undefined) payload.sessionId = opts.sessionId
  const severity = deriveSeverity('step_ended', payload)
  await client.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
          VALUES (?, ?, 'step_ended', ?, ?, NULL, ?, ?)`,
    args: [
      randomUUID(),
      Date.parse(opts.timestamp),
      severity,
      opts.taskId,
      opts.phase,
      JSON.stringify(payload),
    ],
  })
}

const insertToolInvoked = async (
  client: Client,
  opts: { tool: string; timestamp: string; phase: Phase; exitCode?: number },
): Promise<void> => {
  const payload = {
    tool: opts.tool,
    argv: ['--version'],
    exitCode: opts.exitCode ?? 0,
    durationMs: 10,
  }
  await client.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
          VALUES (?, ?, 'tool_invoked', 'info', NULL, NULL, ?, ?)`,
    args: [randomUUID(), Date.parse(opts.timestamp), opts.phase, JSON.stringify(payload)],
  })
}

describe('primitive catalog invariants', () => {
  it('pins the behaviour-verify span step name to BEHAVIOUR_VERIFY_STEP_NAME', () => {
    // The catalog deliberately does not import the behaviour-verify module at
    // runtime; this assertion is the drift guard for the shared literal.
    expect(BEHAVIOUR_VERIFY_SPAN_STEP_NAME).toBe(BEHAVIOUR_VERIFY_STEP_NAME)
  })

  it('maps spans to primitives 1:1 per phase, splitting verify by step name', () => {
    expect(primitiveForSpan('setup', 'setup-worktree')).toBe('setupWorktree')
    expect(primitiveForSpan('code', 'run-claude-code')).toBe('runAgent')
    expect(primitiveForSpan('verify', 'verify')).toBe('verify')
    expect(primitiveForSpan('verify', BEHAVIOUR_VERIFY_SPAN_STEP_NAME)).toBe('behaviourVerify')
    expect(primitiveForSpan('merge', 'merge')).toBe('merge')
    expect(primitiveForSpan(null, 'anything')).toBeNull()
    expect(primitiveForSpan('unknown-phase', 'anything')).toBeNull()
  })
})

describe('viewPrimitives — the catalog list', () => {
  let dbPath: string
  let store: TraceEventStore
  let svc: AppServices

  beforeEach(async () => {
    dbPath = tmpDbPath()
    store = await openTraceEventStore(dbPath)
    svc = makeServices(store)
  })

  afterEach(async () => {
    await store.close()
  })

  it('returns all six primitives in pipeline order with identity fields', async () => {
    const { primitives } = await svc.viewPrimitives()
    expect(primitives.map((p) => p.name)).toEqual([...PRIMITIVE_NAMES])
    for (const p of primitives) {
      expect(p.description.length).toBeGreaterThan(0)
    }
    const byName = new Map(primitives.map((p) => [p.name, p]))
    expect(byName.get('setupWorktree')).toMatchObject({ phase: 'setup', executor: 'shell' })
    expect(byName.get('runAgent')).toMatchObject({ phase: 'code', executor: 'agent' })
    expect(byName.get('verify')).toMatchObject({ phase: 'verify', executor: 'shell' })
    expect(byName.get('behaviourVerify')).toMatchObject({ phase: 'verify', executor: 'agent' })
    expect(byName.get('merge')).toMatchObject({ phase: 'merge', executor: 'shell' })
    expect(byName.get('awaitHuman')).toMatchObject({ phase: null, executor: 'human' })
  })
})

describe('viewPrimitive — identity and tool surface', () => {
  let dbPath: string
  let store: TraceEventStore
  let client: Client
  let svc: AppServices

  beforeEach(async () => {
    dbPath = tmpDbPath()
    store = await openTraceEventStore(dbPath)
    client = openLibsql({ url: `file:${dbPath}` })
    svc = makeServices(store)
  })

  afterEach(async () => {
    client.close()
    await store.close()
  })

  it('returns null for an unknown primitive name', async () => {
    expect(await svc.viewPrimitive({ name: 'not-a-primitive' })).toBeNull()
  })

  it('projects the Coder and Fixer Authorization profiles for runAgent', async () => {
    const detail = await svc.viewPrimitive({ name: 'runAgent' })
    expect(detail).not.toBeNull()
    const byWorker = new Map(detail!.workers.map((w) => [w.workerName, w]))

    const coder = byWorker.get('Coder')
    expect(coder).toBeDefined()
    // Coder: empty denylist + bypassPermissions — the full tool surface.
    expect(coder!.forfeitedTools).toEqual([])
    expect(coder!.permissionMode).toBe('bypassPermissions')
    expect(coder!.source).toBe('built-in')

    const fixer = byWorker.get('Fixer')
    expect(fixer).toBeDefined()
    expect(fixer!.forfeitedTools).toEqual([...FIXER_BACKLOG_DENIED_TOOLS])

    // Declared surface only — no observed shell tools for an agent primitive.
    expect(detail!.observedTools).toEqual([])
  })

  it('includes operator-declared registry Workers as runAgent candidates', async () => {
    const decl: WorkerDeclaration = {
      name: 'DocsWriter',
      model: 'claude-haiku-4-5-20251001',
      effort: 'low',
      permissionMode: 'default',
      bare: false,
      disallowedTools: ['Edit'],
      outputFormat: 'stream-json',
      runtime: 'headless',
      tags: ['docs'],
    }
    const withRegistry = makeServices(store, { loadWorkerDeclarations: () => [decl] })

    const runAgent = await withRegistry.viewPrimitive({ name: 'runAgent' })
    const registryWorker = runAgent!.workers.find((w) => w.workerName === 'DocsWriter')
    expect(registryWorker).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      source: 'registry',
      forfeitedTools: ['Edit'],
    })

    // behaviourVerify is pinned to the BehaviourVerifier — registry Workers
    // never route there.
    const behaviour = await withRegistry.viewPrimitive({ name: 'behaviourVerify' })
    expect(behaviour!.workers.map((w) => w.workerName)).toEqual(['BehaviourVerifier'])
    expect(behaviour!.workers[0]!.forfeitedTools).toEqual([...READ_ONLY_DENIED_TOOLS])
  })

  it('lists observed shell tools (with counts, newest-first lastInvokedAt) for a shell primitive', async () => {
    await insertToolInvoked(client, { tool: 'git', timestamp: '2025-01-01T10:00:00.000Z', phase: 'verify' })
    await insertToolInvoked(client, { tool: 'git', timestamp: '2025-01-01T10:00:02.000Z', phase: 'verify' })
    await insertToolInvoked(client, { tool: 'npx', timestamp: '2025-01-01T10:00:01.000Z', phase: 'verify' })
    // A merge-phase invocation must not leak into verify's surface.
    await insertToolInvoked(client, { tool: 'gh', timestamp: '2025-01-01T10:00:03.000Z', phase: 'merge' })

    const detail = await svc.viewPrimitive({ name: 'verify' })
    expect(detail!.observedTools).toEqual([
      { tool: 'git', count: 2, lastInvokedAt: '2025-01-01T10:00:02.000Z' },
      { tool: 'npx', count: 1, lastInvokedAt: '2025-01-01T10:00:01.000Z' },
    ])
    // Shell primitives have no declared agent surface.
    expect(detail!.workers).toEqual([])
  })

  it('states the merge caveats (Vega escalation, preview dev server) verbatim', async () => {
    const detail = await svc.viewPrimitive({ name: 'merge' })
    expect(detail!.caveats.some((c) => c.includes('Vega'))).toBe(true)
    expect(detail!.caveats.some((c) => c.includes('dev server'))).toBe(true)
  })

  it('gives awaitHuman no tool surface, no spans, and parks as history', async () => {
    const parks: PrimitivePark[] = [
      {
        taskId: 'task-p1',
        stepName: 'design-review',
        parkedAt: '2025-01-01T09:00:00.000Z',
        leaseOwner: 'operator:tty1',
      },
    ]
    const withParks = makeServices(store, { listAwaitingHumanParks: async () => parks })

    const detail = await withParks.viewPrimitive({ name: 'awaitHuman' })
    expect(detail!.primitive.executor).toBe('human')
    expect(detail!.workers).toEqual([])
    expect(detail!.observedTools).toEqual([])
    expect(detail!.runs).toEqual([])
    expect(detail!.parks).toEqual(parks)
  })
})

describe('viewPrimitive — run history', () => {
  let dbPath: string
  let store: TraceEventStore
  let client: Client
  let svc: AppServices

  beforeEach(async () => {
    dbPath = tmpDbPath()
    store = await openTraceEventStore(dbPath)
    client = openLibsql({ url: `file:${dbPath}` })
    svc = makeServices(store)
  })

  afterEach(async () => {
    client.close()
    await store.close()
  })

  it('pairs step_started/step_ended into runs, newest first, across tasks', async () => {
    await insertStarted(client, { taskId: 'task-A', workflowInstanceId: 'wf-1', stepName: 'verify', timestamp: '2025-01-01T10:00:00.000Z', phase: 'verify' })
    await insertEnded(client, { taskId: 'task-A', workflowInstanceId: 'wf-1', stepName: 'verify', timestamp: '2025-01-01T10:00:01.000Z', durationMs: 1000, phase: 'verify' })
    await insertStarted(client, { taskId: 'task-B', workflowInstanceId: 'wf-2', stepName: 'verify', timestamp: '2025-01-01T11:00:00.000Z', phase: 'verify' })
    await insertEnded(client, { taskId: 'task-B', workflowInstanceId: 'wf-2', stepName: 'verify', timestamp: '2025-01-01T11:00:02.000Z', outcome: 'failed', durationMs: 2000, phase: 'verify' })

    const detail = await svc.viewPrimitive({ name: 'verify' })

    expect(detail!.runs).toHaveLength(2)
    // Newest first.
    expect(detail!.runs[0]).toMatchObject({
      taskId: 'task-B',
      workflowInstanceId: 'wf-2',
      outcome: 'failed',
      durationMs: 2000,
    })
    expect(detail!.runs[1]).toMatchObject({
      taskId: 'task-A',
      outcome: 'completed',
      durationMs: 1000,
    })
  })

  it('marks an unpaired step_started as running', async () => {
    await insertStarted(client, { taskId: 'task-run', workflowInstanceId: 'wf-r', stepName: 'merge', timestamp: '2025-01-01T10:00:00.000Z', phase: 'merge' })

    const detail = await svc.viewPrimitive({ name: 'merge' })
    expect(detail!.runs).toHaveLength(1)
    expect(detail!.runs[0]).toMatchObject({ outcome: 'running', endedAt: null, durationMs: null })
  })

  it('splits the shared verify phase: behaviour-verify spans belong to behaviourVerify only', async () => {
    await insertStarted(client, { taskId: 'task-V', workflowInstanceId: 'wf-v', stepName: 'verify', timestamp: '2025-01-01T10:00:00.000Z', phase: 'verify' })
    await insertEnded(client, { taskId: 'task-V', workflowInstanceId: 'wf-v', stepName: 'verify', timestamp: '2025-01-01T10:00:01.000Z', phase: 'verify' })
    await insertStarted(client, { taskId: 'task-V', workflowInstanceId: 'wf-v', stepName: BEHAVIOUR_VERIFY_SPAN_STEP_NAME, timestamp: '2025-01-01T10:00:02.000Z', phase: 'verify', workerName: 'BehaviourVerifier' })
    await insertEnded(client, { taskId: 'task-V', workflowInstanceId: 'wf-v', stepName: BEHAVIOUR_VERIFY_SPAN_STEP_NAME, timestamp: '2025-01-01T10:00:05.000Z', phase: 'verify', sessionId: 'session-bv' })

    const verify = await svc.viewPrimitive({ name: 'verify' })
    expect(verify!.runs.map((r) => r.stepName)).toEqual(['verify'])

    const behaviour = await svc.viewPrimitive({ name: 'behaviourVerify' })
    expect(behaviour!.runs.map((r) => r.stepName)).toEqual([BEHAVIOUR_VERIFY_SPAN_STEP_NAME])
    // A Session span carries Worker + Claude session id.
    expect(behaviour!.runs[0]).toMatchObject({
      workerName: 'BehaviourVerifier',
      claudeSessionId: 'session-bv',
    })
  })

  it('surfaces Worker and Claude session id on runAgent Sessions', async () => {
    await insertStarted(client, { taskId: 'task-S', workflowInstanceId: 'wf-s', stepName: 'run-claude-code', timestamp: '2025-01-01T10:00:00.000Z', phase: 'code', workerName: 'Coder' })
    await insertEnded(client, { taskId: 'task-S', workflowInstanceId: 'wf-s', stepName: 'run-claude-code', timestamp: '2025-01-01T10:05:00.000Z', durationMs: 300000, phase: 'code', sessionId: 'session-coder-1' })

    const detail = await svc.viewPrimitive({ name: 'runAgent' })
    expect(detail!.runs[0]).toMatchObject({
      stepName: 'run-claude-code',
      workerName: 'Coder',
      claudeSessionId: 'session-coder-1',
    })
  })

  it('caps the history at the requested window and reports it', async () => {
    for (let i = 0; i < 5; i++) {
      const ts = `2025-01-01T10:0${i}:00.000Z`
      await insertStarted(client, { taskId: `task-${i}`, workflowInstanceId: `wf-${i}`, stepName: 'setup-worktree', timestamp: ts, phase: 'setup' })
    }

    const detail = await svc.viewPrimitive({ name: 'setupWorktree', limit: 2 })
    expect(detail!.window).toBe(2)
    expect(detail!.runs).toHaveLength(2)
    // The two NEWEST spans survive the cap.
    expect(detail!.runs.map((r) => r.taskId)).toEqual(['task-4', 'task-3'])
  })

  it('defaults the window to 50', async () => {
    const detail = await svc.viewPrimitive({ name: 'verify' })
    expect(detail!.window).toBe(50)
  })
})
