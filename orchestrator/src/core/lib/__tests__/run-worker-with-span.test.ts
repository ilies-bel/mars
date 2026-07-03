import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openTraceEventStore } from '../trace-events-store'
import { runWorkerWithSpan, runNonLlmStepWithSpan } from '../run-worker-with-span'
import type { Worker, WorkerConfig, RunOptions } from '../../workers'
import type { RunClaudeResult } from '../git/claude'
import type { ClaudeEvent } from '../claude-stream'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-worker-span-'))
  return join(dir, 'mars.db')
}

// Minimal WorkerConfig stub that satisfies the interface.
const makeWorkerConfig = (name: WorkerConfig['name']): WorkerConfig => ({
  name,
  model: 'claude-sonnet-4-6',
  effort: 'high',
  permissionMode: 'default',
  bare: false,
  disallowedTools: [],
  outputFormat: 'stream-json',
  maxContextTokens: 0,
  runtime: 'headless',
  provider: 'claude',
})

// Build a mock Worker whose run() resolves to a controlled result without
// spawning a subprocess. This is the external-boundary mock (the real Worker
// forks `claude -p`; we replace that boundary with a deterministic stub).
const makeWorker = (
  name: WorkerConfig['name'],
  result: RunClaudeResult,
): Worker => ({
  config: makeWorkerConfig(name),
  runtime: 'headless',
  run: async (_prompt: string, _options: RunOptions): Promise<RunClaudeResult> => result,
})

// A RunClaudeResult for a successful zero-message run.
const successResult = (sessionId: string | null = null): RunClaudeResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  sessionId,
  conversation: [],
})

// A RunClaudeResult that simulates a non-zero exit.
const failedResult = (): RunClaudeResult => ({
  exitCode: 1,
  stdout: '',
  stderr: 'something went wrong',
  sessionId: null,
  conversation: [],
})

// A RunClaudeResult that simulates a watchdog kill (exit code 138).
const killedResult = (sessionId: string | null = null): RunClaudeResult => ({
  exitCode: 138,
  stdout: '',
  stderr: 'claude -p aborted by caller (read/grep span watcher)',
  sessionId,
  conversation: [],
})

describe('runWorkerWithSpan — Coder run', () => {
  it('records one step_started + one step_ended event with worker name populated', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker = makeWorker('Coder', successResult())

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-coder-001',
      originId: 'task-coder-abc',
      taskId: 'task-coder-abc',
    })

    const events = await traceStore.query({ taskId: 'task-coder-abc' })
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.kind).sort()).toEqual(['step_ended', 'step_started'])
    for (const e of events) {
      expect(e.payload.workerName).toBe('Coder')
      expect(e.payload.stepName).toBe('run-claude-code')
    }
  })

  it('records the session id on the step_ended event', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker = makeWorker('Coder', successResult('sess-abc'))

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-coder-002',
      originId: 'task-coder-def',
      taskId: 'task-coder-def',
    })

    const ended = (await traceStore.query({ taskId: 'task-coder-def', kind: ['step_ended'] }))[0]
    expect(ended.payload.sessionId).toBe('sess-abc')
  })

  it('records outcome=completed and durationMs on a zero-exit run', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker = makeWorker('Coder', successResult('sess-xyz'))

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-coder-003',
      originId: 'task-coder-ghi',
      taskId: 'task-coder-ghi',
    })

    const ended = (await traceStore.query({ taskId: 'task-coder-ghi', kind: ['step_ended'] }))[0]
    expect(ended.payload.outcome).toBe('completed')
    expect(ended.severity).toBe('info')
    expect(typeof ended.payload.durationMs).toBe('number')
  })

  it('populates usage signals even when the conversation is empty', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker = makeWorker('Coder', successResult())

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-coder-004',
      originId: 'task-coder-jkl',
      taskId: 'task-coder-jkl',
    })

    const ended = (await traceStore.query({ taskId: 'task-coder-jkl', kind: ['step_ended'] }))[0]
    expect(ended.payload.usageSignals).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      messageCount: 0,
    })
  })

  it('captures the serialised conversation as transcript when reflection is enabled', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const conversation = [{ type: 'assistant', message: { content: 'hello' } }] as never[]
    const worker = makeWorker('Coder', {
      exitCode: 0,
      stdout: '',
      stderr: '',
      sessionId: null,
      conversation,
    })

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-coder-005',
      originId: 'task-coder-mno',
      taskId: 'task-coder-mno',
    })

    const ended = (await traceStore.query({ taskId: 'task-coder-mno', kind: ['step_ended'] }))[0]
    expect(typeof ended.payload.transcript).toBe('string')
    expect(JSON.parse(ended.payload.transcript as string)).toEqual(conversation)
  })
})

describe('runWorkerWithSpan — Planner / Slicer / Triager / Fixer runs', () => {
  it.each([
    ['Planner', 'generate-plan', 'proposal-abc'],
    ['Slicer', 'generate-slices', 'proposal-xyz'],
    ['Triager', 'generate-triage', 'task-triager-abc'],
    ['Fixer', 'run-claude-code', 'task-fixer-abc'],
  ] as const)('records a step_ended event for a %s run', async (name, stepName, originId) => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker = makeWorker(name, successResult(`sess-${name}`))

    await runWorkerWithSpan({
      worker,
      prompt: 'do the thing',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName,
      workflowInstanceId: `wf-${name}-001`,
      originId,
      taskId: originId,
    })

    const ended = (await traceStore.query({ taskId: originId, kind: ['step_ended'] }))[0]
    expect(ended.payload.workerName).toBe(name)
    expect(ended.payload.sessionId).toBe(`sess-${name}`)
    expect(ended.payload.outcome).toBe('completed')
  })
})

describe('runWorkerWithSpan — failed worker run', () => {
  it('records step_ended with outcome=failed when the worker exits non-zero', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker = makeWorker('Coder', failedResult())

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-fail-001',
      originId: 'task-fail-abc',
      taskId: 'task-fail-abc',
    })

    const ended = (await traceStore.query({ taskId: 'task-fail-abc', kind: ['step_ended'] }))[0]
    expect(ended.payload.outcome).toBe('failed')
    expect(ended.payload.failureReason).toMatch(/^exit-/)
    expect(ended.severity).toBe('error')
  })

  it('records step_ended with outcome=failed when the worker throws', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker: Worker = {
      config: makeWorkerConfig('Coder'),
      runtime: 'headless',
      run: async () => {
        throw new Error('subprocess unexpectedly died')
      },
    }

    await expect(
      runWorkerWithSpan({
        worker,
        prompt: 'implement the thing',
        runOptions: { cwd: '/tmp' },
        traceStore,
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-throw-001',
        originId: 'task-throw-abc',
        taskId: 'task-throw-abc',
      }),
    ).rejects.toThrow('subprocess unexpectedly died')

    const ended = (await traceStore.query({ taskId: 'task-throw-abc', kind: ['step_ended'] }))[0]
    expect(ended.payload.outcome).toBe('failed')
    expect(ended.payload.failureReason).toContain('subprocess unexpectedly died')
    expect(ended.severity).toBe('error')
  })

  it('records step_ended with outcome=killed when the watchdog fires (exit code 138)', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker = makeWorker('Coder', killedResult('sess-kill'))

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-killed-001',
      originId: 'task-killed-abc',
      taskId: 'task-killed-abc',
    })

    const ended = (await traceStore.query({ taskId: 'task-killed-abc', kind: ['step_ended'] }))[0]
    expect(ended.payload.outcome).toBe('killed')
    // killed is a distinct outcome — not failure, not completed
    expect(ended.payload.outcome).not.toBe('failed')
    expect(ended.payload.outcome).not.toBe('completed')
    // severity is warn, not error — watchdog kill is a problem but not a hard task failure
    expect(ended.severity).toBe('warn')
    // end time is always set (non-null) — the timestamp on the step_ended event
    expect(typeof ended.timestamp).toBe('string')
    expect(ended.timestamp.length).toBeGreaterThan(0)
    // no failureReason on killed sessions
    expect(ended.payload.failureReason).toBeUndefined()
    // session id is preserved even on killed sessions
    expect(ended.payload.sessionId).toBe('sess-kill')
  })

  it('re-throws the original error so the caller still sees the failure', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const thrownError = new Error('critical failure')
    const worker: Worker = {
      config: makeWorkerConfig('Fixer'),
      runtime: 'headless',
      run: async () => {
        throw thrownError
      },
    }

    await expect(
      runWorkerWithSpan({
        worker,
        prompt: 'fix things',
        runOptions: { cwd: '/tmp' },
        traceStore,
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-rethrow-001',
        originId: 'task-rethrow-abc',
        taskId: 'task-rethrow-abc',
      }),
    ).rejects.toBe(thrownError)
  })
})

describe('runWorkerWithSpan — trace store write errors are non-fatal', () => {
  it('returns the worker result even when record() throws', async () => {
    const brokenStore = {
      record: async (): Promise<void> => {
        throw new Error('DB unavailable')
      },
      query: async () => [],
      close: async () => {},
    }
    const worker = makeWorker('Coder', successResult('sess-ok'))

    const result = await runWorkerWithSpan({
      worker,
      prompt: 'implement',
      runOptions: { cwd: '/tmp' },
      traceStore: brokenStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-broken-001',
      originId: 'task-broken-abc',
      taskId: 'task-broken-abc',
    })

    expect(result.exitCode).toBe(0)
    expect(result.sessionId).toBe('sess-ok')
  })
})

describe('runWorkerWithSpan — phase tag', () => {
  it('attaches the optional phase tag to both events', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker = makeWorker('Coder', successResult())

    await runWorkerWithSpan({
      worker,
      prompt: 'do thing',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-phase-001',
      originId: 'task-phase',
      taskId: 'task-phase',
      phase: 'code',
    })

    const events = await traceStore.query({ taskId: 'task-phase' })
    for (const e of events) {
      expect(e.phase).toBe('code')
    }
  })
})

// ── runNonLlmStepWithSpan ──────────────────────────────────────────────────

describe('runNonLlmStepWithSpan — successful step', () => {
  it('records one step_started and one step_ended event', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'setup-worktree',
      workflowInstanceId: 'wf-nonllm-001',
      originId: 'task-nonllm-abc',
      taskId: 'task-nonllm-abc',
      phase: 'setup',
      traceStore,
      fn: async () => 'done',
    })

    const events = await traceStore.query({ taskId: 'task-nonllm-abc' })
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.kind).sort()).toEqual(['step_ended', 'step_started'])
  })

  it('records stepName and workflowInstanceId in both events', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'setup-worktree',
      workflowInstanceId: 'wf-nonllm-002',
      originId: 'task-nonllm-payload',
      taskId: 'task-nonllm-payload',
      phase: 'setup',
      traceStore,
      fn: async () => undefined,
    })

    const events = await traceStore.query({ taskId: 'task-nonllm-payload' })
    for (const e of events) {
      expect(e.payload.stepName).toBe('setup-worktree')
      expect(e.payload.workflowInstanceId).toBe('wf-nonllm-002')
    }
  })

  it('carries NO workerName and NO sessionId — these are Step spans, not Sessions', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'merge',
      workflowInstanceId: 'wf-nonllm-003',
      originId: 'task-nonllm-nosession',
      taskId: 'task-nonllm-nosession',
      phase: 'merge',
      traceStore,
      fn: async () => undefined,
    })

    const events = await traceStore.query({ taskId: 'task-nonllm-nosession' })
    for (const e of events) {
      expect(e.payload.workerName).toBeUndefined()
      expect(e.payload.sessionId).toBeUndefined()
    }
  })

  it('records outcome=completed on success with durationMs', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'verify',
      workflowInstanceId: 'wf-nonllm-004',
      originId: 'task-nonllm-completed',
      taskId: 'task-nonllm-completed',
      phase: 'verify',
      traceStore,
      fn: async () => 42,
    })

    const ended = (
      await traceStore.query({ taskId: 'task-nonllm-completed', kind: ['step_ended'] })
    )[0]
    expect(ended.payload.outcome).toBe('completed')
    expect(ended.severity).toBe('info')
    expect(typeof ended.payload.durationMs).toBe('number')
  })

  it('attaches the phase tag to both events', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'merge',
      workflowInstanceId: 'wf-nonllm-phase',
      originId: 'task-nonllm-phase',
      taskId: 'task-nonllm-phase',
      phase: 'merge',
      traceStore,
      fn: async () => undefined,
    })

    const events = await traceStore.query({ taskId: 'task-nonllm-phase' })
    for (const e of events) {
      expect(e.phase).toBe('merge')
    }
  })

  it('returns the value the fn resolved to', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    const result = await runNonLlmStepWithSpan({
      stepName: 'setup-worktree',
      workflowInstanceId: 'wf-nonllm-ret',
      originId: 'task-nonllm-ret',
      taskId: 'task-nonllm-ret',
      phase: 'setup',
      traceStore,
      fn: async () => ({ path: '/tmp/wt', branch: 'task/abc' }),
    })

    expect(result).toEqual({ path: '/tmp/wt', branch: 'task/abc' })
  })
})

describe('runNonLlmStepWithSpan — live in-flight state', () => {
  it('shows only step_started before fn completes — the in-flight "running" state', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    let midRunStarted: unknown[] = []
    let midRunEnded: unknown[] = []

    await runNonLlmStepWithSpan({
      stepName: 'setup-worktree',
      workflowInstanceId: 'wf-inflight',
      originId: 'task-inflight',
      taskId: 'task-inflight',
      phase: 'setup',
      traceStore,
      fn: async () => {
        midRunStarted = await traceStore.query({ taskId: 'task-inflight', kind: ['step_started'] })
        midRunEnded = await traceStore.query({ taskId: 'task-inflight', kind: ['step_ended'] })
        return 'result'
      },
    })

    // During fn execution: step_started present, step_ended absent → running
    expect(midRunStarted).toHaveLength(1)
    expect(midRunEnded).toHaveLength(0)

    // After completion: both events present
    const allEvents = await traceStore.query({ taskId: 'task-inflight' })
    expect(allEvents).toHaveLength(2)
  })
})

describe('runNonLlmStepWithSpan — failed step', () => {
  it('records outcome=failed and re-throws when fn throws', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const boom = new Error('worktree creation failed')

    await expect(
      runNonLlmStepWithSpan({
        stepName: 'setup-worktree',
        workflowInstanceId: 'wf-fail-nonllm',
        originId: 'task-fail-nonllm',
        taskId: 'task-fail-nonllm',
        phase: 'setup',
        traceStore,
        fn: async () => {
          throw boom
        },
      }),
    ).rejects.toBe(boom)

    const ended = (
      await traceStore.query({ taskId: 'task-fail-nonllm', kind: ['step_ended'] })
    )[0]
    expect(ended.payload.outcome).toBe('failed')
    expect(ended.payload.failureReason).toContain('worktree creation failed')
    expect(ended.severity).toBe('error')
  })

  it('records step_started before step_ended even on failure', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await expect(
      runNonLlmStepWithSpan({
        stepName: 'verify',
        workflowInstanceId: 'wf-fail-verify',
        originId: 'task-fail-verify',
        taskId: 'task-fail-verify',
        phase: 'verify',
        traceStore,
        fn: async () => {
          throw new Error('verify:typecheck failed')
        },
      }),
    ).rejects.toThrow()

    const started = await traceStore.query({ taskId: 'task-fail-verify', kind: ['step_started'] })
    expect(started).toHaveLength(1)
  })
})

describe('runNonLlmStepWithSpan — Vega upgrade (conflicted merge)', () => {
  it('records workerName=Vega and sessionId when getVegaInfo returns non-null', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'merge',
      workflowInstanceId: 'wf-vega-001',
      originId: 'task-vega-abc',
      taskId: 'task-vega-abc',
      phase: 'merge',
      traceStore,
      getVegaInfo: () => ({ workerName: 'Vega', sessionId: 'sess-vega-xyz' }),
      fn: async () => undefined,
    })

    const ended = (await traceStore.query({ taskId: 'task-vega-abc', kind: ['step_ended'] }))[0]
    expect(ended.payload.workerName).toBe('Vega')
    expect(ended.payload.sessionId).toBe('sess-vega-xyz')
    expect(ended.payload.outcome).toBe('completed')
  })

  it('carries NO workerName and NO sessionId when getVegaInfo returns null (fast-forward merge)', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'merge',
      workflowInstanceId: 'wf-ff-001',
      originId: 'task-ff-abc',
      taskId: 'task-ff-abc',
      phase: 'merge',
      traceStore,
      getVegaInfo: () => null,
      fn: async () => undefined,
    })

    const events = await traceStore.query({ taskId: 'task-ff-abc' })
    for (const e of events) {
      expect(e.payload.workerName).toBeUndefined()
      expect(e.payload.sessionId).toBeUndefined()
    }
  })

  it('produces exactly one step_started and one step_ended — not two spans', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'merge',
      workflowInstanceId: 'wf-vega-single-span',
      originId: 'task-vega-single',
      taskId: 'task-vega-single',
      phase: 'merge',
      traceStore,
      getVegaInfo: () => ({ workerName: 'Vega', sessionId: 'sess-vega-single' }),
      fn: async () => undefined,
    })

    const events = await traceStore.query({ taskId: 'task-vega-single' })
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.kind).sort()).toEqual(['step_ended', 'step_started'])
  })

  it('satisfies the Session invariant: step_ended has workerName iff getVegaInfo is non-null', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    // Conflicted merge: getVegaInfo returns Vega info → span IS a Session
    await runNonLlmStepWithSpan({
      stepName: 'merge',
      workflowInstanceId: 'wf-invariant-conflict',
      originId: 'task-invariant-conflict',
      taskId: 'task-invariant-conflict',
      phase: 'merge',
      traceStore,
      getVegaInfo: () => ({ workerName: 'Vega', sessionId: 'sess-invariant' }),
      fn: async () => undefined,
    })

    // Fast-forward merge: no getVegaInfo → span is NOT a Session
    await runNonLlmStepWithSpan({
      stepName: 'merge',
      workflowInstanceId: 'wf-invariant-ff',
      originId: 'task-invariant-ff',
      taskId: 'task-invariant-ff',
      phase: 'merge',
      traceStore,
      fn: async () => undefined,
    })

    const conflictEnded = (
      await traceStore.query({ taskId: 'task-invariant-conflict', kind: ['step_ended'] })
    )[0]
    const ffEnded = (
      await traceStore.query({ taskId: 'task-invariant-ff', kind: ['step_ended'] })
    )[0]

    // Conflicted merge span IS a Session (workerName present)
    expect(typeof conflictEnded.payload.workerName).toBe('string')
    // Fast-forward span is NOT a Session (no workerName)
    expect(ffEnded.payload.workerName).toBeUndefined()
  })
})

describe('runNonLlmStepWithSpan — trace store write errors are non-fatal', () => {
  it('still runs and returns even when record() throws', async () => {
    const brokenStore = {
      record: async (): Promise<void> => {
        throw new Error('DB unavailable')
      },
      query: async () => [],
      close: async () => {},
    }

    const result = await runNonLlmStepWithSpan({
      stepName: 'merge',
      workflowInstanceId: 'wf-broken-nonllm',
      originId: 'task-broken-nonllm',
      taskId: 'task-broken-nonllm',
      phase: 'merge',
      traceStore: brokenStore,
      fn: async () => 'success',
    })

    expect(result).toBe('success')
  })

  it('still re-throws fn errors even when the store is broken', async () => {
    const brokenStore = {
      record: async (): Promise<void> => {
        throw new Error('DB unavailable')
      },
      query: async () => [],
      close: async () => {},
    }

    await expect(
      runNonLlmStepWithSpan({
        stepName: 'merge',
        workflowInstanceId: 'wf-broken-throw',
        originId: 'task-broken-throw',
        taskId: 'task-broken-throw',
        phase: 'merge',
        traceStore: brokenStore,
        fn: async () => {
          throw new Error('fn failed')
        },
      }),
    ).rejects.toThrow('fn failed')
  })
})

// ── getCommandOutput callback ──────────────────────────────────────────────

describe('runNonLlmStepWithSpan — command output', () => {
  it('stores command output in step_ended payload when getCommandOutput returns a string', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'verify',
      workflowInstanceId: 'wf-cmdout-001',
      originId: 'task-cmdout-pass',
      taskId: 'task-cmdout-pass',
      phase: 'verify',
      traceStore,
      getCommandOutput: () => '=== typecheck (pass) ===\n0 errors',
      fn: async () => undefined,
    })

    const ended = (await traceStore.query({ taskId: 'task-cmdout-pass', kind: ['step_ended'] }))[0]
    expect(ended.payload.commandOutput).toBe('=== typecheck (pass) ===\n0 errors')
  })

  it('stores command output in step_ended payload even when fn throws', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await expect(
      runNonLlmStepWithSpan({
        stepName: 'verify',
        workflowInstanceId: 'wf-cmdout-002',
        originId: 'task-cmdout-fail',
        taskId: 'task-cmdout-fail',
        phase: 'verify',
        traceStore,
        getCommandOutput: () => '=== typecheck (fail) ===\nerror TS2345: bad type',
        fn: async () => {
          throw new Error('verify:typecheck failed')
        },
      }),
    ).rejects.toThrow()

    const ended = (await traceStore.query({ taskId: 'task-cmdout-fail', kind: ['step_ended'] }))[0]
    expect(ended.payload.commandOutput).toBe('=== typecheck (fail) ===\nerror TS2345: bad type')
  })

  it('omits commandOutput from step_ended payload when getCommandOutput is absent', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'setup-worktree',
      workflowInstanceId: 'wf-cmdout-003',
      originId: 'task-cmdout-absent',
      taskId: 'task-cmdout-absent',
      phase: 'setup',
      traceStore,
      fn: async () => undefined,
    })

    const ended = (
      await traceStore.query({ taskId: 'task-cmdout-absent', kind: ['step_ended'] })
    )[0]
    expect(ended.payload.commandOutput).toBeUndefined()
  })

  it('omits commandOutput from step_ended payload when getCommandOutput returns undefined', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'verify',
      workflowInstanceId: 'wf-cmdout-004',
      originId: 'task-cmdout-undef',
      taskId: 'task-cmdout-undef',
      phase: 'verify',
      traceStore,
      getCommandOutput: () => undefined,
      fn: async () => undefined,
    })

    const ended = (
      await traceStore.query({ taskId: 'task-cmdout-undef', kind: ['step_ended'] })
    )[0]
    expect(ended.payload.commandOutput).toBeUndefined()
  })

  it('does NOT include commandOutput in step_started — only step_ended', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'verify',
      workflowInstanceId: 'wf-cmdout-005',
      originId: 'task-cmdout-started',
      taskId: 'task-cmdout-started',
      phase: 'verify',
      traceStore,
      getCommandOutput: () => 'some output',
      fn: async () => undefined,
    })

    const started = (
      await traceStore.query({ taskId: 'task-cmdout-started', kind: ['step_started'] })
    )[0]
    expect(started.payload.commandOutput).toBeUndefined()
  })
})

// ── multiple verify spans (three verify attempts) ──────────────────────────

describe('runNonLlmStepWithSpan — three verify attempts produce three spans', () => {
  it('three calls with the same originId produce three step_ended events all with stepName=verify', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const originId = 'task-triple-verify'

    for (let i = 0; i < 3; i++) {
      await runNonLlmStepWithSpan({
        stepName: 'verify',
        workflowInstanceId: `wf-triple-${i}`,
        originId,
        taskId: originId,
        phase: 'verify',
        traceStore,
        fn: async () => undefined,
      })
    }

    const ended = await traceStore.query({ taskId: originId, kind: ['step_ended'] })
    expect(ended).toHaveLength(3)
    for (const e of ended) {
      expect(e.payload.stepName).toBe('verify')
    }
  })

  it('each of the three spans has a distinct workflowInstanceId', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const originId = 'task-triple-wfid'

    for (let i = 0; i < 3; i++) {
      await runNonLlmStepWithSpan({
        stepName: 'verify',
        workflowInstanceId: `wf-triple-distinct-${i}`,
        originId,
        taskId: originId,
        phase: 'verify',
        traceStore,
        fn: async () => undefined,
      })
    }

    const ended = await traceStore.query({ taskId: originId, kind: ['step_ended'] })
    const wfIds = ended.map((e) => e.payload.workflowInstanceId as string)
    const uniqueWfIds = new Set(wfIds)
    expect(uniqueWfIds.size).toBe(3)
  })

  it('three verify spans each store distinct command output', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const originId = 'task-triple-output'

    for (let i = 0; i < 3; i++) {
      const output = `attempt-${i}: verify output`
      await runNonLlmStepWithSpan({
        stepName: 'verify',
        workflowInstanceId: `wf-triple-out-${i}`,
        originId,
        taskId: originId,
        phase: 'verify',
        traceStore,
        getCommandOutput: () => output,
        fn: async () => undefined,
      })
    }

    const ended = await traceStore.query({ taskId: originId, kind: ['step_ended'] })
    expect(ended).toHaveLength(3)
    const outputs = ended.map((e) => e.payload.commandOutput as string)
    // Each attempt has distinct output
    expect(new Set(outputs).size).toBe(3)
  })
})

// ── taskId is distinct from originId ──────────────────────────────────────

describe('runWorkerWithSpan — taskId stamps spans with the real task id', () => {
  it('attributes spans to taskId, not originId, when they differ', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker = makeWorker('Coder', successResult())

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-taskid-distinct-001',
      originId: 'origin-proposal-aaa',
      taskId: 'task-child-bbb',
    })

    // Spans attributed to the real task id
    const byTaskId = await traceStore.query({ taskId: 'task-child-bbb' })
    expect(byTaskId).toHaveLength(2)

    // NOT attributed to the origin id
    const byOriginId = await traceStore.query({ taskId: 'origin-proposal-aaa' })
    expect(byOriginId).toHaveLength(0)
  })

  it('attributes slicer spans with null taskId — not attributed to the proposal id', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker = makeWorker('Slicer', successResult())

    await runWorkerWithSpan({
      worker,
      prompt: 'slice the proposal',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'generate-slices',
      workflowInstanceId: 'wf-slicer-taskid-001',
      originId: 'proposal-xyz',
      taskId: null,
    })

    // Slicer spans are NOT attributed to the proposal id
    const byProposalId = await traceStore.query({ taskId: 'proposal-xyz' })
    expect(byProposalId).toHaveLength(0)
  })
})

describe('runNonLlmStepWithSpan — taskId stamps spans with the real task id', () => {
  it('attributes spans to taskId, not originId, when they differ', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())

    await runNonLlmStepWithSpan({
      stepName: 'setup-worktree',
      workflowInstanceId: 'wf-taskid-nonllm-distinct-001',
      originId: 'origin-proposal-ccc',
      taskId: 'task-child-ddd',
      phase: 'setup',
      traceStore,
      fn: async () => undefined,
    })

    const byTaskId = await traceStore.query({ taskId: 'task-child-ddd' })
    expect(byTaskId).toHaveLength(2)

    const byOriginId = await traceStore.query({ taskId: 'origin-proposal-ccc' })
    expect(byOriginId).toHaveLength(0)
  })
})

// ── recovery dispatch produces distinct span ──────────────────────────────

describe('runNonLlmStepWithSpan — recovery dispatch produces distinct span', () => {
  it('recovery-dispatch span coexists with the verify span under the same originId', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const originId = 'task-recovery-span'
    const wfId = 'wf-recovery-001'

    // Simulate: verify fails and dispatches recovery inside the verify span
    await expect(
      runNonLlmStepWithSpan({
        stepName: 'verify',
        workflowInstanceId: wfId,
        originId,
        taskId: originId,
        phase: 'verify',
        traceStore,
        fn: async () => {
          // Recovery dispatch gets its own span
          await runNonLlmStepWithSpan({
            stepName: 'recovery-dispatch',
            workflowInstanceId: wfId,
            originId,
            taskId: originId,
            phase: 'verify',
            traceStore,
            fn: async () => ({ fixTaskId: 'fix-001', created: true }),
          })
          // Verify then throws
          throw new Error('verify:typecheck failed')
        },
      }),
    ).rejects.toThrow('verify:typecheck failed')

    const allEvents = await traceStore.query({ taskId: originId })
    const stepNames = allEvents.map((e) => e.payload.stepName as string)

    expect(stepNames).toContain('verify')
    expect(stepNames).toContain('recovery-dispatch')
  })

  it('recovery-dispatch span closes with outcome=completed when dispatch succeeds', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const originId = 'task-recovery-outcome'
    const wfId = 'wf-recovery-002'

    await expect(
      runNonLlmStepWithSpan({
        stepName: 'verify',
        workflowInstanceId: wfId,
        originId,
        taskId: originId,
        phase: 'verify',
        traceStore,
        fn: async () => {
          await runNonLlmStepWithSpan({
            stepName: 'recovery-dispatch',
            workflowInstanceId: wfId,
            originId,
            taskId: originId,
            phase: 'verify',
            traceStore,
            fn: async () => ({ fixTaskId: 'fix-002', created: true }),
          })
          throw new Error('verify:test failed')
        },
      }),
    ).rejects.toThrow()

    const recoveryEnded = (
      await traceStore.query({ taskId: originId, kind: ['step_ended'] })
    ).find((e) => e.payload.stepName === 'recovery-dispatch')
    expect(recoveryEnded).toBeDefined()
    expect(recoveryEnded?.payload.outcome).toBe('completed')
    expect(recoveryEnded?.severity).toBe('info')
  })

  it('verify span closes with outcome=failed after recovery-dispatch completes', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const originId = 'task-verify-failed-after-recovery'
    const wfId = 'wf-recovery-003'

    await expect(
      runNonLlmStepWithSpan({
        stepName: 'verify',
        workflowInstanceId: wfId,
        originId,
        taskId: originId,
        phase: 'verify',
        traceStore,
        fn: async () => {
          await runNonLlmStepWithSpan({
            stepName: 'recovery-dispatch',
            workflowInstanceId: wfId,
            originId,
            taskId: originId,
            phase: 'verify',
            traceStore,
            fn: async () => undefined,
          })
          throw new Error('verify:lint failed')
        },
      }),
    ).rejects.toThrow()

    const verifyEnded = (
      await traceStore.query({ taskId: originId, kind: ['step_ended'] })
    ).find((e) => e.payload.stepName === 'verify')
    expect(verifyEnded?.payload.outcome).toBe('failed')
    expect(verifyEnded?.severity).toBe('error')
  })
})

// ── failure-path partial usage capture ────────────────────────────────────────

describe('runWorkerWithSpan — failure-path partial usage capture', () => {
  it('records usageSignals when the worker throws after emitting streaming events', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker: Worker = {
      config: makeWorkerConfig('Coder'),
      runtime: 'headless',
      run: async (_prompt: string, options: RunOptions): Promise<RunClaudeResult> => {
        // Simulate: model produces output then the process crashes
        await options.onEvent?.({
          type: 'assistant',
          message: {
            usage: { input_tokens: 100, output_tokens: 25 },
            content: [],
          },
        } as ClaudeEvent)
        throw new Error('subprocess died after partial work')
      },
    }

    await expect(
      runWorkerWithSpan({
        worker,
        prompt: 'do work',
        runOptions: { cwd: '/tmp' },
        traceStore,
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-partial-001',
        originId: 'task-partial-abc',
        taskId: 'task-partial-abc',
      }),
    ).rejects.toThrow('subprocess died after partial work')

    const ended = (await traceStore.query({ taskId: 'task-partial-abc', kind: ['step_ended'] }))[0]
    expect(ended.payload.outcome).toBe('failed')
    // Partial usage from the events emitted before the throw
    expect(ended.payload.usageSignals).toMatchObject({
      inputTokens: 100,
      outputTokens: 25,
      messageCount: 1,
    })
  })

  it('records zero usageSignals when the worker throws before emitting any events', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker: Worker = {
      config: makeWorkerConfig('Coder'),
      runtime: 'headless',
      run: async (): Promise<RunClaudeResult> => {
        throw new Error('immediate failure')
      },
    }

    await expect(
      runWorkerWithSpan({
        worker,
        prompt: 'do work',
        runOptions: { cwd: '/tmp' },
        traceStore,
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-zero-001',
        originId: 'task-zero-abc',
        taskId: 'task-zero-abc',
      }),
    ).rejects.toThrow('immediate failure')

    const ended = (await traceStore.query({ taskId: 'task-zero-abc', kind: ['step_ended'] }))[0]
    expect(ended.payload.outcome).toBe('failed')
    // No events were emitted — all signals are zero but the field is present
    expect(ended.payload.usageSignals).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      messageCount: 0,
    })
  })

  it('still calls the caller-supplied onEvent callback on accumulation', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const received: ClaudeEvent[] = []
    const worker: Worker = {
      config: makeWorkerConfig('Coder'),
      runtime: 'headless',
      run: async (_prompt: string, options: RunOptions): Promise<RunClaudeResult> => {
        await options.onEvent?.({
          type: 'assistant',
          message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
        } as ClaudeEvent)
        return { exitCode: 0, stdout: '', stderr: '', sessionId: null, conversation: [] }
      },
    }

    await runWorkerWithSpan({
      worker,
      prompt: 'do work',
      runOptions: {
        cwd: '/tmp',
        onEvent: (e) => {
          received.push(e)
        },
      },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-onevent-pass',
      originId: 'task-onevent-pass',
      taskId: 'task-onevent-pass',
    })

    // The caller's onEvent was still called
    expect(received).toHaveLength(1)
    expect(received[0]!.type).toBe('assistant')
  })
})

// ── Full implement-arc span attribution (PRD-slice regression) ────────────
//
// Root cause that motivated this suite (fixed in run-worker-with-span.ts):
// before `taskId: string | null` was added to RunWorkerWithSpanOptions and
// RunNonLlmStepOptions, every `safeRecord` call hardcoded `taskId: originId`,
// so ALL step spans for a 13-slice PRD were attributed to the origin task id
// instead of each slice's own id. The DB query showed 16 Coder step_ended
// events under `task_id = origin_id`; only 1 slice (mars-57816516) got a
// correctly stamped span.
//
// These tests guard the full implement-arc spine (all 4 steps) under the
// precise scenario where slice.taskId ≠ origin.taskId.

describe('implement-arc span attribution — all 4 steps attribute to the slice task id', () => {
  it('setup-worktree, run-claude-code, verify, and merge all use the slice task id, not the origin task id', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker = makeWorker('Coder', successResult('sess-prd-slice'))

    // PRD sliced into child tasks:
    //   origin task = 'origin-prd-task-aaa'  (the proposal / origin id)
    //   slice task  = 'slice-task-bbb'        (the concrete slice being implemented)
    // Every step in the implement arc must attribute to 'slice-task-bbb'.
    const sliceTaskId = 'slice-task-bbb'
    const originTaskId = 'origin-prd-task-aaa'
    const wfId = 'wf-implement-arc-regression'

    // Step 1: setup-worktree (non-LLM)
    await runNonLlmStepWithSpan({
      stepName: 'setup-worktree',
      workflowInstanceId: wfId,
      originId: originTaskId,
      taskId: sliceTaskId,
      phase: 'setup',
      traceStore,
      fn: async () => undefined,
    })

    // Step 2: run-claude-code (LLM / Coder) — the step where the original
    // bug was most visible: 16 events stamped with origin id instead of slice id.
    await runWorkerWithSpan({
      worker,
      prompt: 'implement the slice',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: wfId,
      originId: originTaskId,
      taskId: sliceTaskId,
      phase: 'code',
    })

    // Step 3: verify (non-LLM)
    await runNonLlmStepWithSpan({
      stepName: 'verify',
      workflowInstanceId: wfId,
      originId: originTaskId,
      taskId: sliceTaskId,
      phase: 'verify',
      traceStore,
      fn: async () => undefined,
    })

    // Step 4: merge (non-LLM)
    await runNonLlmStepWithSpan({
      stepName: 'merge',
      workflowInstanceId: wfId,
      originId: originTaskId,
      taskId: sliceTaskId,
      phase: 'merge',
      traceStore,
      fn: async () => undefined,
    })

    // 4 steps × 2 events each = 8 events; ALL must carry the slice task id.
    const bySlice = await traceStore.query({ taskId: sliceTaskId })
    expect(bySlice).toHaveLength(8)

    const stepNames = new Set(bySlice.map((e) => e.payload.stepName as string))
    expect(stepNames).toContain('setup-worktree')
    expect(stepNames).toContain('run-claude-code')
    expect(stepNames).toContain('verify')
    expect(stepNames).toContain('merge')

    // Zero events must be attributed to the origin task id.
    const byOrigin = await traceStore.query({ taskId: originTaskId })
    expect(byOrigin).toHaveLength(0)
  })

  it('slicer-level steps (generate-slices) emit taskId = null — origin id is NOT used as task id', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker = makeWorker('Slicer', successResult())

    await runWorkerWithSpan({
      worker,
      prompt: 'slice the proposal',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'generate-slices',
      workflowInstanceId: 'wf-slicer-null-taskid',
      originId: 'origin-prd-task-aaa',
      taskId: null,
    })

    // task_id IS NULL — not attributed to the origin task id
    const byOrigin = await traceStore.query({ taskId: 'origin-prd-task-aaa' })
    expect(byOrigin).toHaveLength(0)
  })
})

// ── Incremental transcript streaming ──────────────────────────────────────

describe('runWorkerWithSpan — incremental transcript chunk streaming', () => {
  it('persists streamed events to task_transcripts so a killed session is readable', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    // Worker streams two events then throws (simulating a watchdog kill)
    const worker: Worker = {
      config: makeWorkerConfig('Coder'),
      runtime: 'headless',
      run: async (_prompt: string, options: RunOptions): Promise<RunClaudeResult> => {
        await options.onEvent?.({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '# Progress' }] },
        } as ClaudeEvent)
        await options.onEvent?.({
          type: 'result',
          result: 'task done',
        } as unknown as ClaudeEvent)
        throw new Error('watchdog kill')
      },
    }

    await expect(
      runWorkerWithSpan({
        worker,
        prompt: 'do work',
        runOptions: { cwd: '/tmp', sessionId: 'sess-killed-123' },
        traceStore,
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-chunk-kill',
        originId: 'task-chunk-kill',
        taskId: 'task-chunk-kill',
        phase: 'code',
      }),
    ).rejects.toThrow('watchdog kill')

    // The partial transcript must be readable from task_transcripts even
    // though no step_ended was written (the throw happened before that).
    const chunks = await traceStore.readTranscriptChunks!('task-chunk-kill')
    expect(chunks.length).toBeGreaterThan(0)
    const types = (chunks as Array<{ type: string }>).map((e) => e.type)
    expect(types).toContain('assistant')
    expect(types).toContain('result')
  })

  it('streams chunks during a successful run and reads them back', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker: Worker = {
      config: makeWorkerConfig('Coder'),
      runtime: 'headless',
      run: async (_prompt: string, options: RunOptions): Promise<RunClaudeResult> => {
        await options.onEvent?.({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'starting...' }] },
        } as ClaudeEvent)
        return { exitCode: 0, stdout: '', stderr: '', sessionId: 'sess-ok-456', conversation: [] }
      },
    }

    await runWorkerWithSpan({
      worker,
      prompt: 'do work',
      runOptions: { cwd: '/tmp', sessionId: 'sess-ok-456' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-chunk-ok',
      originId: 'task-chunk-ok',
      taskId: 'task-chunk-ok',
      phase: 'code',
    })

    const chunks = await traceStore.readTranscriptChunks!('task-chunk-ok')
    expect(chunks.length).toBeGreaterThan(0)
    expect((chunks[0] as { type: string }).type).toBe('assistant')
  })

  it('does not write chunks when taskId is null (slicer runs)', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const worker: Worker = {
      config: makeWorkerConfig('Slicer'),
      runtime: 'headless',
      run: async (_prompt: string, options: RunOptions): Promise<RunClaudeResult> => {
        await options.onEvent?.({ type: 'assistant', message: { content: [] } } as ClaudeEvent)
        return { exitCode: 0, stdout: '', stderr: '', sessionId: null, conversation: [] }
      },
    }

    await runWorkerWithSpan({
      worker,
      prompt: 'slice',
      runOptions: { cwd: '/tmp', sessionId: 'sess-slicer' },
      traceStore,
      stepName: 'generate-slices',
      workflowInstanceId: 'wf-chunk-slicer',
      originId: 'origin-slicer',
      taskId: null, // null taskId → no chunks written
    })

    // null taskId means no chunk rows
    const chunks = await traceStore.readTranscriptChunks!('origin-slicer')
    expect(chunks).toHaveLength(0)
  })

  it('reads chunks written by streaming store in preference to step_ended payload', async () => {
    // This test verifies the fallback priority: task_transcripts > step_ended > disk.
    // Set up a store with chunks for task-X but no step_ended with a transcript.
    const traceStore = await openTraceEventStore(tmpDbPath())
    try {
      // Manually insert streaming chunks
      await traceStore.appendTranscriptChunk!(
        'task-priority',
        'sess-stream',
        0,
        [{ type: 'result', result: 'from streaming store' }],
      )
      // Also write a step_ended with a different transcript
      await traceStore.record({
        kind: 'step_ended',
        taskId: 'task-priority',
        phase: 'code',
        payload: {
          stepName: 'run-claude-code',
          workflowInstanceId: 'wf-priority',
          outcome: 'completed',
          transcript: JSON.stringify([{ type: 'result', result: 'from step_ended' }]),
        },
      })

      // readTranscriptChunks reads streaming store
      const chunks = await traceStore.readTranscriptChunks!('task-priority')
      expect(chunks).toHaveLength(1)
      expect((chunks[0] as { result: string }).result).toBe('from streaming store')
    } finally {
      await traceStore.close()
    }
  })
})

// ── worker-model-mismatch guard ───────────────────────────────────────────────
//
// Root cause for the Fixer-on-Opus incident (2026-07-03): the pinned model in
// WORKER_CONFIGS.Fixer was claude-opus-4-7 before commit 77b0f693. Even after
// the pin was corrected, there is no runtime signal that catches future drift.
// The guard added in runWorkerWithSpan compares the model field of the
// system/init event (the first event the claude CLI emits, carrying the model
// it actually selected) against worker.config.model. A mismatch emits a
// severity=warn trace event so budget drift is visible in reflect without
// blocking the run itself.

describe('runWorkerWithSpan — worker-model-mismatch guard', () => {
  it('emits a worker-model-mismatch warn event when the system/init model diverges from the worker pin', async () => {
    // Fixer is pinned to claude-sonnet-4-6. If the live subprocess reports
    // claude-opus-4-7 (the pre-77b0f693 pin), the guard must fire a warn.
    const traceStore = await openTraceEventStore(tmpDbPath())
    const fixerWorker: Worker = {
      config: makeWorkerConfig('Fixer'), // model: 'claude-sonnet-4-6'
      runtime: 'headless',
      run: async (_prompt: string, options: RunOptions): Promise<RunClaudeResult> => {
        // Simulate the claude CLI's system/init event reporting the WRONG model
        await options.onEvent?.({
          type: 'system',
          subtype: 'init',
          session_id: 'sess-mismatch-fixer',
          model: 'claude-opus-4-7', // diverges from worker.config.model
        } as ClaudeEvent)
        return successResult('sess-mismatch-fixer')
      },
    }

    await runWorkerWithSpan({
      worker: fixerWorker,
      prompt: 'fix the failing test',
      runOptions: { cwd: '/tmp', sessionId: 'sess-mismatch-fixer' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-mismatch-fixer-001',
      originId: 'task-mismatch-fixer',
      taskId: 'task-mismatch-fixer',
      phase: 'code',
    })

    const mismatches = await traceStore.query({ kind: ['worker-model-mismatch'] })
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]!.severity).toBe('warn')
    expect(mismatches[0]!.payload.expected).toBe('claude-sonnet-4-6')
    expect(mismatches[0]!.payload.actual).toBe('claude-opus-4-7')
    expect(mismatches[0]!.payload.worker).toBe('Fixer')
    expect(mismatches[0]!.payload.taskId).toBe('task-mismatch-fixer')
    expect(mismatches[0]!.phase).toBe('code')
  })

  it('does NOT emit worker-model-mismatch when system/init model matches the worker pin', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const fixerWorker: Worker = {
      config: makeWorkerConfig('Fixer'), // model: 'claude-sonnet-4-6'
      runtime: 'headless',
      run: async (_prompt: string, options: RunOptions): Promise<RunClaudeResult> => {
        await options.onEvent?.({
          type: 'system',
          subtype: 'init',
          session_id: 'sess-match',
          model: 'claude-sonnet-4-6', // matches worker.config.model exactly
        } as ClaudeEvent)
        return successResult('sess-match')
      },
    }

    await runWorkerWithSpan({
      worker: fixerWorker,
      prompt: 'fix the thing',
      runOptions: { cwd: '/tmp', sessionId: 'sess-match' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-match-001',
      originId: 'task-match',
      taskId: 'task-match',
      phase: 'code',
    })

    const mismatches = await traceStore.query({ kind: ['worker-model-mismatch'] })
    expect(mismatches).toHaveLength(0)
  })

  it('does NOT emit worker-model-mismatch for non-init system events', async () => {
    // Only type=system AND subtype=init should trigger the guard.
    // A system event with a different subtype (e.g. result) must not fire.
    const traceStore = await openTraceEventStore(tmpDbPath())
    const fixerWorker: Worker = {
      config: makeWorkerConfig('Fixer'), // model: 'claude-sonnet-4-6'
      runtime: 'headless',
      run: async (_prompt: string, options: RunOptions): Promise<RunClaudeResult> => {
        await options.onEvent?.({
          type: 'system',
          subtype: 'result', // not 'init' — must not trigger guard
          model: 'claude-opus-4-7',
        } as ClaudeEvent)
        return successResult()
      },
    }

    await runWorkerWithSpan({
      worker: fixerWorker,
      prompt: 'fix the thing',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-noinit-001',
      originId: 'task-noinit',
      taskId: 'task-noinit',
      phase: 'code',
    })

    const mismatches = await traceStore.query({ kind: ['worker-model-mismatch'] })
    expect(mismatches).toHaveLength(0)
  })

  it('guard is non-fatal: the run still completes and the result is returned even after emitting mismatch', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const fixerWorker: Worker = {
      config: makeWorkerConfig('Fixer'), // model: 'claude-sonnet-4-6'
      runtime: 'headless',
      run: async (_prompt: string, options: RunOptions): Promise<RunClaudeResult> => {
        await options.onEvent?.({
          type: 'system',
          subtype: 'init',
          session_id: 'sess-nonfatal',
          model: 'claude-opus-4-7', // mismatch
        } as ClaudeEvent)
        return successResult('sess-nonfatal')
      },
    }

    const result = await runWorkerWithSpan({
      worker: fixerWorker,
      prompt: 'fix things',
      runOptions: { cwd: '/tmp', sessionId: 'sess-nonfatal' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-nonfatal-001',
      originId: 'task-nonfatal',
      taskId: 'task-nonfatal',
      phase: 'code',
    })

    // The run should still complete normally
    expect(result.exitCode).toBe(0)
    expect(result.sessionId).toBe('sess-nonfatal')
    // The mismatch was still recorded
    const mismatches = await traceStore.query({ kind: ['worker-model-mismatch'] })
    expect(mismatches).toHaveLength(1)
  })
})
