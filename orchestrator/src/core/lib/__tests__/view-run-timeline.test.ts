/**
 * Unit tests for the viewRunTimeline projection in AppServices.
 *
 * Tests the observable behaviour of the projection through its public interface:
 * createAppServices({ traceStore }).viewRunTimeline(taskId). All assertions
 * target the RunTimeline wire shape — never internal state.
 *
 * Uses a real TraceEventStore backed by a temp SQLite file so the full
 * query/pairing path executes (including the timestamp-ordering and
 * workflowInstanceId-grouping logic).
 *
 * Trace events are inserted via direct SQL with explicit ISO-8601 timestamps
 * so test assertions on chronological ordering are deterministic regardless of
 * wall-clock speed.
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
import type { AppServices } from '../../app-services'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-run-timeline-'))
  return join(dir, 'mars.db')
}

/** Build a minimal AppServices with only the trace store wired in. */
const makeServices = (traceStore: TraceEventStore): AppServices =>
  createAppServices({
    traceStore,
    buildAlertSources: async () => ({
      listFailedArcs: async () => [],
      listStaleWorktrees: async () => [],
      listVerifyUncovered: async () => [],
    }),
  })

/**
 * Insert a step_started row directly with an explicit timestamp so tests can
 * control chronological ordering without relying on wall-clock speed.
 */
const insertStarted = async (
  client: Client,
  opts: {
    taskId: string
    workflowInstanceId: string
    stepName: string
    timestamp: string
    workerName?: string
    phase?: 'setup' | 'code' | 'verify' | 'merge'
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
    args: [
      randomUUID(),
      Date.parse(opts.timestamp),
      opts.taskId,
      opts.phase ?? null,
      JSON.stringify(payload),
    ],
  })
}

/**
 * Insert a step_ended row directly with an explicit timestamp. Supports the
 * full payload shape including usageSignals (for token assertions).
 */
const insertEnded = async (
  client: Client,
  opts: {
    taskId: string
    workflowInstanceId: string
    stepName: string
    timestamp: string
    outcome?: 'completed' | 'failed' | 'killed'
    durationMs?: number
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    sessionId?: string
    failureReason?: string
    summary?: string
    phase?: 'setup' | 'code' | 'verify' | 'merge'
  },
): Promise<void> => {
  const outcome = opts.outcome ?? 'completed'
  const payload: Record<string, unknown> = {
    stepName: opts.stepName,
    workflowInstanceId: opts.workflowInstanceId,
    outcome,
    durationMs: opts.durationMs ?? 100,
  }
  if (opts.inputTokens !== undefined || opts.outputTokens !== undefined) {
    payload.usageSignals = {
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
      cacheReadTokens: opts.cacheReadTokens ?? 0,
      cacheCreateTokens: 0,
      messageCount: 1,
      contextTokens: 0,
    }
  }
  if (opts.sessionId !== undefined) payload.sessionId = opts.sessionId
  if (opts.failureReason !== undefined) payload.failureReason = opts.failureReason
  if (opts.summary !== undefined) payload.summary = opts.summary

  const severity = deriveSeverity('step_ended', payload)
  await client.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
          VALUES (?, ?, 'step_ended', ?, ?, NULL, ?, ?)`,
    args: [
      randomUUID(),
      Date.parse(opts.timestamp),
      severity,
      opts.taskId,
      opts.phase ?? null,
      JSON.stringify(payload),
    ],
  })
}

describe('viewRunTimeline — basic grouping and ordering', () => {
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

  it('returns empty runs for a task with no trace events', async () => {
    const result = await svc.viewRunTimeline('task-unknown')
    expect(result.taskId).toBe('task-unknown')
    expect(result.runs).toEqual([])
  })

  it('groups steps into a single run when all share one workflowInstanceId', async () => {
    const taskId = 'task-A'
    const runId = 'wf-1'

    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.000Z', phase: 'setup' })
    await insertEnded(client, { taskId, workflowInstanceId: runId, stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.200Z', durationMs: 200, phase: 'setup' })

    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'run-claude-code', timestamp: '2025-01-01T10:00:00.200Z', workerName: 'Coder', phase: 'code' })
    await insertEnded(client, {
      taskId,
      workflowInstanceId: runId,
      stepName: 'run-claude-code',
      timestamp: '2025-01-01T10:00:05.200Z',
      durationMs: 5000,
      phase: 'code',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      sessionId: 'session-abc',
    })

    const result = await svc.viewRunTimeline(taskId)

    expect(result.runs).toHaveLength(1)
    expect(result.runs[0].runId).toBe(runId)
    expect(result.runs[0].steps).toHaveLength(2)
    expect(result.runs[0].steps.map((s) => s.stepName)).toEqual([
      'setup-worktree',
      'run-claude-code',
    ])
  })

  it('groups steps into two runs when two workflowInstanceIds are present', async () => {
    const taskId = 'task-B'

    // Run 1 — older timestamps
    await insertStarted(client, { taskId, workflowInstanceId: 'wf-1', stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.000Z', phase: 'setup' })
    await insertEnded(client, { taskId, workflowInstanceId: 'wf-1', stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.100Z', durationMs: 100, phase: 'setup' })

    // Run 2 (recovery) — newer timestamps
    await insertStarted(client, { taskId, workflowInstanceId: 'wf-2', stepName: 'setup-worktree', timestamp: '2025-01-01T10:05:00.000Z', phase: 'setup' })
    await insertEnded(client, { taskId, workflowInstanceId: 'wf-2', stepName: 'setup-worktree', timestamp: '2025-01-01T10:05:00.150Z', durationMs: 150, phase: 'setup' })

    const result = await svc.viewRunTimeline(taskId)

    expect(result.runs).toHaveLength(2)
    // Runs are returned in chronological order (wf-1 started first).
    expect(result.runs[0].runId).toBe('wf-1')
    expect(result.runs[1].runId).toBe('wf-2')
  })

  it('marks a step as running when step_started has no matching step_ended', async () => {
    const taskId = 'task-C'
    const runId = 'wf-3'

    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'run-claude-code', timestamp: '2025-01-01T10:00:00.000Z', workerName: 'Coder', phase: 'code' })
    // No step_ended — step is still in flight.

    const result = await svc.viewRunTimeline(taskId)

    expect(result.runs).toHaveLength(1)
    const step = result.runs[0].steps[0]
    expect(step.stepName).toBe('run-claude-code')
    expect(step.status).toBe('running')
    expect(step.endedAt).toBeNull()
    expect(step.durationMs).toBeNull()
  })
})

describe('viewRunTimeline — step fields', () => {
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

  it('extracts token usage from usageSignals on the step_ended event', async () => {
    const taskId = 'task-tok'
    const runId = 'wf-tok'

    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'run-claude-code', timestamp: '2025-01-01T10:00:00.000Z', workerName: 'Coder', phase: 'code' })
    await insertEnded(client, {
      taskId,
      workflowInstanceId: runId,
      stepName: 'run-claude-code',
      timestamp: '2025-01-01T10:00:03.000Z',
      durationMs: 3000,
      phase: 'code',
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadTokens: 89,
    })

    const result = await svc.viewRunTimeline(taskId)
    const step = result.runs[0].steps[0]

    expect(step.inputTokens).toBe(1234)
    expect(step.outputTokens).toBe(567)
    expect(step.cacheReadTokens).toBe(89)
  })

  it('exposes null token fields on non-LLM steps without usageSignals', async () => {
    const taskId = 'task-setup'
    const runId = 'wf-setup'

    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.000Z', phase: 'setup' })
    await insertEnded(client, { taskId, workflowInstanceId: runId, stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.200Z', durationMs: 200, phase: 'setup' })

    const result = await svc.viewRunTimeline(taskId)
    const step = result.runs[0].steps[0]

    expect(step.inputTokens).toBeNull()
    expect(step.outputTokens).toBeNull()
    expect(step.cacheReadTokens).toBeNull()
  })

  it('surfaces claudeSessionId from the step_ended sessionId field', async () => {
    const taskId = 'task-sess'
    const runId = 'wf-sess'

    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'run-claude-code', timestamp: '2025-01-01T10:00:00.000Z', workerName: 'Coder', phase: 'code' })
    await insertEnded(client, {
      taskId,
      workflowInstanceId: runId,
      stepName: 'run-claude-code',
      timestamp: '2025-01-01T10:00:02.000Z',
      durationMs: 2000,
      phase: 'code',
      sessionId: 'session-xyz-456',
    })

    const result = await svc.viewRunTimeline(taskId)
    const step = result.runs[0].steps[0]

    expect(step.claudeSessionId).toBe('session-xyz-456')
  })

  it('surfaces failureReason from the step_ended payload', async () => {
    const taskId = 'task-fail'
    const runId = 'wf-fail'

    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'verify', timestamp: '2025-01-01T10:00:00.000Z', phase: 'verify' })
    await insertEnded(client, {
      taskId,
      workflowInstanceId: runId,
      stepName: 'verify',
      timestamp: '2025-01-01T10:00:01.000Z',
      outcome: 'failed',
      durationMs: 1000,
      phase: 'verify',
      failureReason: 'exit-1',
    })

    const result = await svc.viewRunTimeline(taskId)
    const step = result.runs[0].steps[0]

    expect(step.status).toBe('failed')
    expect(step.failureReason).toBe('exit-1')
  })

  it('maps outcome killed → status killed', async () => {
    const taskId = 'task-killed'
    const runId = 'wf-killed'

    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'run-claude-code', timestamp: '2025-01-01T10:00:00.000Z', workerName: 'Coder', phase: 'code' })
    await insertEnded(client, {
      taskId,
      workflowInstanceId: runId,
      stepName: 'run-claude-code',
      timestamp: '2025-01-01T10:00:00.500Z',
      outcome: 'killed',
      durationMs: 500,
      phase: 'code',
    })

    const result = await svc.viewRunTimeline(taskId)
    const step = result.runs[0].steps[0]

    expect(step.status).toBe('killed')
  })

  it('surfaces summary from the step_ended payload (reflect steps)', async () => {
    const taskId = 'task-reflect-sum'
    const runId = 'wf-reflect-sum'

    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'analyze-token-economy', timestamp: '2025-01-01T10:00:00.000Z', phase: 'verify' })
    await insertEnded(client, {
      taskId,
      workflowInstanceId: runId,
      stepName: 'analyze-token-economy',
      timestamp: '2025-01-01T10:00:00.200Z',
      durationMs: 200,
      phase: 'verify',
      summary: '12 repeated reads, 10 failed calls, ~66300 tokens wasted',
    })

    const result = await svc.viewRunTimeline(taskId)
    const step = result.runs[0].steps[0]

    expect(step.summary).toBe('12 repeated reads, 10 failed calls, ~66300 tokens wasted')
  })

  it('returns null summary when no summary in the step_ended payload', async () => {
    const taskId = 'task-no-sum'
    const runId = 'wf-no-sum'

    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.000Z', phase: 'setup' })
    await insertEnded(client, { taskId, workflowInstanceId: runId, stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.100Z', durationMs: 100, phase: 'setup' })

    const result = await svc.viewRunTimeline(taskId)
    const step = result.runs[0].steps[0]

    expect(step.summary).toBeNull()
  })
})

describe('viewRunTimeline — run endedAt and totals', () => {
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

  it('sets run endedAt to null when any step is still running', async () => {
    const taskId = 'task-running'
    const runId = 'wf-run'

    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.000Z', phase: 'setup' })
    await insertEnded(client, { taskId, workflowInstanceId: runId, stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.100Z', durationMs: 100, phase: 'setup' })

    // This step has no step_ended → still running
    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'run-claude-code', timestamp: '2025-01-01T10:00:00.100Z', workerName: 'Coder', phase: 'code' })

    const result = await svc.viewRunTimeline(taskId)

    expect(result.runs[0].endedAt).toBeNull()
  })

  it('sets run endedAt to the latest step endedAt when all steps are done', async () => {
    const taskId = 'task-done'
    const runId = 'wf-done'

    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.000Z', phase: 'setup' })
    await insertEnded(client, { taskId, workflowInstanceId: runId, stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.100Z', durationMs: 100, phase: 'setup' })
    await insertStarted(client, { taskId, workflowInstanceId: runId, stepName: 'verify', timestamp: '2025-01-01T10:00:00.100Z', phase: 'verify' })
    await insertEnded(client, { taskId, workflowInstanceId: runId, stepName: 'verify', timestamp: '2025-01-01T10:00:00.300Z', durationMs: 200, phase: 'verify' })

    const result = await svc.viewRunTimeline(taskId)
    const run = result.runs[0]

    // endedAt is non-null and is a valid ISO-8601 string
    expect(run.endedAt).not.toBeNull()
    // endedAt should be the later of the two step timestamps
    expect(run.endedAt).toBe('2025-01-01T10:00:00.300Z')
  })

  it('does not include steps for other tasks', async () => {
    const taskIdA = 'task-iso-A'
    const taskIdB = 'task-iso-B'

    await insertStarted(client, { taskId: taskIdA, workflowInstanceId: 'wf-A', stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:00.000Z', phase: 'setup' })
    await insertStarted(client, { taskId: taskIdB, workflowInstanceId: 'wf-B', stepName: 'setup-worktree', timestamp: '2025-01-01T10:00:01.000Z', phase: 'setup' })

    const resultA = await svc.viewRunTimeline(taskIdA)
    const resultB = await svc.viewRunTimeline(taskIdB)

    expect(resultA.runs).toHaveLength(1)
    expect(resultA.runs[0].runId).toBe('wf-A')
    expect(resultB.runs).toHaveLength(1)
    expect(resultB.runs[0].runId).toBe('wf-B')
  })
})
