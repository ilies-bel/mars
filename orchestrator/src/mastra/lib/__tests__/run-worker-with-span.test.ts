import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openTraceEventStore } from '../trace-events-store'
import { runWorkerWithSpan, runNonLlmStepWithSpan } from '../run-worker-with-span'
import type { Worker, WorkerConfig, RunOptions } from '../../workers'
import type { RunClaudeResult } from '../git'

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
  maxMessages: 0,
  runtime: 'headless',
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
        phase: 'verify',
        traceStore,
        fn: async () => {
          // Recovery dispatch gets its own span
          await runNonLlmStepWithSpan({
            stepName: 'recovery-dispatch',
            workflowInstanceId: wfId,
            originId,
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
        phase: 'verify',
        traceStore,
        fn: async () => {
          await runNonLlmStepWithSpan({
            stepName: 'recovery-dispatch',
            workflowInstanceId: wfId,
            originId,
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
        phase: 'verify',
        traceStore,
        fn: async () => {
          await runNonLlmStepWithSpan({
            stepName: 'recovery-dispatch',
            workflowInstanceId: wfId,
            originId,
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
