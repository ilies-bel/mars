/**
 * Verify output and model attribution on the durable event surface
 * (ADR-0097 "One typed event…", modular-core slice 8).
 *
 * Before this slice both facts existed only inside a run transcript, which is
 * stored separately and pruned on its own schedule. These tests pin the two
 * new kinds — `verify.step.completed` and `worker.model.attributed` — as
 * durable `trace_events` rows emitted by the REAL code paths (`verifyChanges`
 * and `runWorkerWithSpan`), attributed to a task id and a phase, and readable
 * back through the same `store.query({ taskId })` call `GET /events?taskId=`
 * makes.
 *
 * Everything asserted here is observable through the store's public read path;
 * nothing reaches into internal state.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  openTraceEventStore,
  TRACE_EVENT_KINDS,
  VERIFY_OUTPUT_TAIL_BYTES,
  type TraceEvent,
  type TraceEventStore,
} from '../trace-events-store'
import { isUnifiedEventKind } from '../../../bus/emit'
import { verifyChanges } from '../git/verify'
import { runWorkerWithSpan } from '../run-worker-with-span'
import { PROVIDER_MODELS } from '../../workers/provider-types'
import type { Worker, WorkerConfig, RunOptions } from '../../workers'
import type { RunAgentResult } from '../git/claude'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-verify-attribution-'))
  return join(dir, 'mars.db')
}

const eventOfKind = (events: readonly TraceEvent[], kind: string): TraceEvent => {
  const match = events.find((e) => e.kind === kind)
  if (!match) {
    throw new Error(
      `no '${kind}' event; got: ${events.map((e) => e.kind).join(', ') || '<none>'}`,
    )
  }
  return match
}

// Minimal Worker stub. Pinned to the claude provider so tier lookups are
// deterministic regardless of MARS_WORKER_PROVIDER in the environment.
const makeWorker = (overrides: Partial<WorkerConfig> = {}): Worker => {
  const config: WorkerConfig = {
    name: 'Coder',
    model: PROVIDER_MODELS['claude']['balanced'],
    modelTier: 'balanced',
    effort: 'high',
    permissionMode: 'default',
    bare: false,
    disallowedTools: [],
    outputFormat: 'stream-json',
    maxContextTokens: 0,
    runtime: 'headless',
    provider: 'claude',
    ...overrides,
  }
  return {
    config,
    runtime: 'headless',
    run: async (_prompt: string, _options: RunOptions): Promise<RunAgentResult> => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    }),
  }
}

describe('durable verify-output and model-attribution events', () => {
  it('registers both kinds in the unified kind registry', () => {
    expect(TRACE_EVENT_KINDS).toContain('verify.step.completed')
    expect(TRACE_EVENT_KINDS).toContain('worker.model.attributed')
    expect(isUnifiedEventKind('verify.step.completed')).toBe(true)
    expect(isUnifiedEventKind('worker.model.attributed')).toBe(true)
  })

  it('verifyChanges emits a verify.step.completed row per step, with command, exit code and output tails', async () => {
    const store: TraceEventStore = await openTraceEventStore(tmpDbPath())
    try {
      const result = await verifyChanges({
        cwd: tmpdir(),
        steps: [
          {
            name: 'green-gate',
            cmd: 'sh',
            args: ['-c', 'echo to-stdout'],
            required: true,
          },
          {
            name: 'red-gate',
            cmd: 'sh',
            args: ['-c', 'echo to-stdout; echo to-stderr >&2; exit 3'],
            required: true,
          },
        ],
        traceCtx: {
          taskId: 'task-verify-1',
          originId: 'origin-verify-1',
          phase: 'verify',
          store,
        },
      })
      expect(result.verdict).toBe('FAIL')

      const events = await store.query({
        taskId: 'task-verify-1',
        kind: ['verify.step.completed'],
      })
      expect(events.map((e) => e.payload.step).sort()).toEqual([
        'green-gate',
        'red-gate',
      ])

      // The envelope carries the identity, not the payload: this is what
      // `GET /events?taskId=` filters on.
      for (const e of events) {
        expect(e.taskId).toBe('task-verify-1')
        expect(e.originId).toBe('origin-verify-1')
        expect(e.phase).toBe('verify')
      }

      const green = events.find((e) => e.payload.step === 'green-gate')!
      expect(green.payload.exitCode).toBe(0)
      expect(green.payload.command).toBe('sh -c echo to-stdout')
      expect(green.payload.stdoutTail).toContain('to-stdout')
      expect(green.severity).toBe('info')

      const red = events.find((e) => e.payload.step === 'red-gate')!
      expect(red.payload.exitCode).toBe(3)
      expect(red.payload.stdoutTail).toContain('to-stdout')
      expect(red.payload.stderrTail).toContain('to-stderr')
      // A failing gate is worth surfacing above the info floor.
      expect(red.severity).toBe('warn')
    } finally {
      await store.close()
    }
  })

  it('truncates verify output to a bounded tail so one noisy gate cannot bloat the event log', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      const lines = VERIFY_OUTPUT_TAIL_BYTES // 1 byte of digits + newline each, comfortably over the cap
      await verifyChanges({
        cwd: tmpdir(),
        steps: [
          {
            name: 'noisy-gate',
            cmd: 'sh',
            args: ['-c', `for i in $(seq 1 ${lines}); do echo 123456789; done`],
            required: true,
          },
        ],
        traceCtx: { taskId: 'task-verify-2', phase: 'verify', store },
      })

      const events = await store.query({ taskId: 'task-verify-2' })
      const payload = eventOfKind(events, 'verify.step.completed').payload
      const stdoutTail = payload.stdoutTail as string
      // Truncated to the TAIL — the end of a failing run is where the error is.
      expect(stdoutTail.length).toBeLessThan(VERIFY_OUTPUT_TAIL_BYTES * 2)
      expect(stdoutTail).toContain('bytes truncated')
      expect(stdoutTail.endsWith('123456789\n')).toBe(true)
    } finally {
      await store.close()
    }
  })

  it('runWorkerWithSpan emits worker.model.attributed for the model it actually dispatched', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      // Worker is pinned to balanced; the caller overrides to fast, so the
      // attributed model/tier must reflect the override, not the pin.
      await runWorkerWithSpan({
        worker: makeWorker(),
        prompt: 'implement the thing',
        runOptions: { cwd: tmpdir() },
        traceStore: store,
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-attribution-1',
        originId: 'origin-attr-1',
        taskId: 'task-attr-1',
        phase: 'code',
        modelTier: 'fast',
      })

      const events = await store.query({ taskId: 'task-attr-1' })
      const attributed = eventOfKind(events, 'worker.model.attributed')
      expect(attributed.taskId).toBe('task-attr-1')
      expect(attributed.originId).toBe('origin-attr-1')
      expect(attributed.phase).toBe('code')
      expect(attributed.payload).toEqual({
        workerName: 'Coder',
        stepName: 'run-claude-code',
        provider: 'claude',
        model: PROVIDER_MODELS['claude']['fast'],
        tier: 'fast',
      })
    } finally {
      await store.close()
    }
  })

  it('attributes a model pinned outside the provider tier table with a null tier', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await runWorkerWithSpan({
        worker: makeWorker({ model: 'claude-operator-pin-9', modelTier: undefined }),
        prompt: 'implement the thing',
        runOptions: { cwd: tmpdir() },
        traceStore: store,
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-attribution-2',
        originId: 'origin-attr-2',
        taskId: 'task-attr-2',
        phase: 'code',
      })

      const events = await store.query({ taskId: 'task-attr-2' })
      const attributed = eventOfKind(events, 'worker.model.attributed')
      expect(attributed.payload.model).toBe('claude-operator-pin-9')
      expect(attributed.payload.tier).toBeNull()
    } finally {
      await store.close()
    }
  })

  it('both payloads survive a store round-trip together under one task id', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await verifyChanges({
        cwd: tmpdir(),
        steps: [
          { name: 'gate', cmd: 'sh', args: ['-c', 'echo ok'], required: true },
        ],
        traceCtx: { taskId: 'task-both-1', phase: 'verify', store },
      })
      await runWorkerWithSpan({
        worker: makeWorker(),
        prompt: 'p',
        runOptions: { cwd: tmpdir() },
        traceStore: store,
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-both-1',
        originId: 'task-both-1',
        taskId: 'task-both-1',
        phase: 'code',
      })

      // The exact read `GET /events?taskId=<id>` performs — no transcript
      // table is consulted.
      const events = await store.query({ taskId: 'task-both-1' })
      expect(eventOfKind(events, 'verify.step.completed').payload).toMatchObject({
        step: 'gate',
        command: 'sh -c echo ok',
        exitCode: 0,
      })
      expect(eventOfKind(events, 'worker.model.attributed').payload).toMatchObject({
        provider: 'claude',
        model: PROVIDER_MODELS['claude']['balanced'],
        tier: 'balanced',
      })
    } finally {
      await store.close()
    }
  })
})
