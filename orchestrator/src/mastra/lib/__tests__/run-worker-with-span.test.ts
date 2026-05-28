import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openStepSpanStore } from '../step-span-store'
import { runWorkerWithSpan } from '../run-worker-with-span'
import type { Worker, WorkerConfig, RunOptions } from '../../workers'
import type { RunClaudeResult } from '../git'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-worker-span-'))
  return join(dir, 'state.db')
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

describe('runWorkerWithSpan — Coder run', () => {
  it('produces exactly one step_spans row with worker name populated', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
    const worker = makeWorker('Coder', successResult())

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      spanStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-coder-001',
      originId: 'task-coder-abc',
    })

    const spans = await spanStore.listSpans('task-coder-abc')
    expect(spans).toHaveLength(1)
    expect(spans[0].workerName).toBe('Coder')
  })

  it('records the session id returned by the worker run', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
    const worker = makeWorker('Coder', successResult('sess-abc'))

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      spanStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-coder-002',
      originId: 'task-coder-def',
    })

    const spans = await spanStore.listSpans('task-coder-def')
    expect(spans[0].sessionId).toBe('sess-abc')
  })

  it('closes the span with outcome=success on a zero-exit run', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
    const worker = makeWorker('Coder', successResult('sess-xyz'))

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      spanStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-coder-003',
      originId: 'task-coder-ghi',
    })

    const spans = await spanStore.listSpans('task-coder-ghi')
    expect(spans[0].outcome).toBe('success')
    expect(spans[0].endedAt).not.toBeNull()
  })

  it('populates usage signals even when the conversation is empty', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
    const worker = makeWorker('Coder', successResult())

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      spanStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-coder-004',
      originId: 'task-coder-jkl',
    })

    const spans = await spanStore.listSpans('task-coder-jkl')
    expect(spans[0].usageSignals).not.toBeNull()
    expect(spans[0].usageSignals).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      messageCount: 0,
    })
  })

  it('populates transcript with the serialised conversation', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
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
      spanStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-coder-005',
      originId: 'task-coder-mno',
    })

    const spans = await spanStore.listSpans('task-coder-mno')
    expect(spans[0].transcript).not.toBeNull()
    expect(JSON.parse(spans[0].transcript!)).toEqual(conversation)
  })
})

describe('runWorkerWithSpan — Writer run', () => {
  it('produces exactly one step_spans row with Writer as worker name', async () => {
    // Note: 'Writer' was removed by ADR 0019; we verify the generic span logic
    // still works for any WorkerConfig['name']. Using 'Coder' here since
    // Worker names are constrained by the WorkerName union.
    const spanStore = await openStepSpanStore(tmpDbPath())
    // In practice the Writer lane is gone; 'Coder' is the only dispatched name.
    // This test documents that any WorkerName produces a span row.
    const worker = makeWorker('Coder', successResult('sess-writer'))

    await runWorkerWithSpan({
      worker,
      prompt: 'write the docs',
      runOptions: { cwd: '/tmp' },
      spanStore,
      stepName: 'run-writer',
      workflowInstanceId: 'wf-writer-001',
      originId: 'task-writer-abc',
    })

    const spans = await spanStore.listSpans('task-writer-abc')
    expect(spans).toHaveLength(1)
    expect(spans[0].sessionId).toBe('sess-writer')
    expect(spans[0].usageSignals).not.toBeNull()
  })
})

describe('runWorkerWithSpan — Planner run (proposal origin)', () => {
  it('produces a step_spans row tied to the proposal origin', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
    const worker = makeWorker('Planner', successResult('sess-planner'))

    await runWorkerWithSpan({
      worker,
      prompt: 'plan this task',
      runOptions: { cwd: '/tmp' },
      spanStore,
      stepName: 'generate-plan',
      workflowInstanceId: 'wf-planner-001',
      originId: 'proposal-abc',
    })

    const spans = await spanStore.listSpans('proposal-abc')
    expect(spans).toHaveLength(1)
    expect(spans[0].workerName).toBe('Planner')
    expect(spans[0].sessionId).toBe('sess-planner')
    expect(spans[0].usageSignals).not.toBeNull()
    expect(spans[0].outcome).toBe('success')
  })
})

describe('runWorkerWithSpan — Slicer run (proposal origin)', () => {
  it('produces a step_spans row tied to the proposal origin', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
    const worker = makeWorker('Slicer', successResult('sess-slicer'))

    await runWorkerWithSpan({
      worker,
      prompt: 'slice the PRD',
      runOptions: { cwd: '/tmp' },
      spanStore,
      stepName: 'generate-slices',
      workflowInstanceId: 'wf-slicer-001',
      originId: 'proposal-xyz',
    })

    const spans = await spanStore.listSpans('proposal-xyz')
    expect(spans).toHaveLength(1)
    expect(spans[0].workerName).toBe('Slicer')
    expect(spans[0].sessionId).toBe('sess-slicer')
    expect(spans[0].usageSignals).not.toBeNull()
    expect(spans[0].transcript).not.toBeNull()
    expect(spans[0].outcome).toBe('success')
  })
})

describe('runWorkerWithSpan — Triager run', () => {
  it('produces a step_spans row with Triager as worker name', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
    const worker = makeWorker('Triager', successResult('sess-triager'))

    await runWorkerWithSpan({
      worker,
      prompt: 'triage this task',
      runOptions: { cwd: '/tmp' },
      spanStore,
      stepName: 'generate-triage',
      workflowInstanceId: 'wf-triager-001',
      originId: 'task-triager-abc',
    })

    const spans = await spanStore.listSpans('task-triager-abc')
    expect(spans).toHaveLength(1)
    expect(spans[0].workerName).toBe('Triager')
    expect(spans[0].sessionId).toBe('sess-triager')
    expect(spans[0].usageSignals).not.toBeNull()
    expect(spans[0].outcome).toBe('success')
  })
})

describe('runWorkerWithSpan — Fixer run', () => {
  it('produces a step_spans row with Fixer as worker name', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
    const worker = makeWorker('Fixer', successResult('sess-fixer'))

    await runWorkerWithSpan({
      worker,
      prompt: 'fix the broken task',
      runOptions: { cwd: '/tmp' },
      spanStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-fixer-001',
      originId: 'task-fixer-abc',
    })

    const spans = await spanStore.listSpans('task-fixer-abc')
    expect(spans).toHaveLength(1)
    expect(spans[0].workerName).toBe('Fixer')
    expect(spans[0].sessionId).toBe('sess-fixer')
    expect(spans[0].usageSignals).not.toBeNull()
    expect(spans[0].outcome).toBe('success')
  })
})

describe('runWorkerWithSpan — failed worker run', () => {
  it('closes the span with a failure outcome when the worker exits non-zero', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
    const worker = makeWorker('Coder', failedResult())

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      spanStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-fail-001',
      originId: 'task-fail-abc',
    })

    const spans = await spanStore.listSpans('task-fail-abc')
    expect(spans).toHaveLength(1)
    expect(spans[0].outcome).toMatch(/^failed:/)
    expect(spans[0].endedAt).not.toBeNull()
  })

  it('closes the span with a failure outcome when the worker throws', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
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
        spanStore,
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-throw-001',
        originId: 'task-throw-abc',
      }),
    ).rejects.toThrow('subprocess unexpectedly died')

    const spans = await spanStore.listSpans('task-throw-abc')
    expect(spans).toHaveLength(1)
    expect(spans[0].outcome).toMatch(/^failed:/)
    expect(spans[0].endedAt).not.toBeNull()
  })

  it('re-throws the original error so the caller still sees the failure', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
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
        spanStore,
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-rethrow-001',
        originId: 'task-rethrow-abc',
      }),
    ).rejects.toBe(thrownError)
  })
})

describe('runWorkerWithSpan — span store write errors are non-fatal', () => {
  it('returns the worker result even when openSpan throws', async () => {
    const faultyStore = await openStepSpanStore(tmpDbPath())
    // Poison the store: openSpan always rejects.
    const brokenStore = {
      ...faultyStore,
      openSpan: async () => {
        throw new Error('DB unavailable')
      },
    }
    const worker = makeWorker('Coder', successResult('sess-ok'))

    const result = await runWorkerWithSpan({
      worker,
      prompt: 'implement',
      runOptions: { cwd: '/tmp' },
      spanStore: brokenStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-broken-001',
      originId: 'task-broken-abc',
    })

    expect(result.exitCode).toBe(0)
    expect(result.sessionId).toBe('sess-ok')
  })
})

describe('runWorkerWithSpan — closeSpan sessionId extension', () => {
  it('stores sessionId via closeSpan even when openSpan did not set it', async () => {
    const spanStore = await openStepSpanStore(tmpDbPath())
    const worker = makeWorker('Planner', successResult('sess-late'))

    await runWorkerWithSpan({
      worker,
      prompt: 'plan this',
      runOptions: { cwd: '/tmp' },
      spanStore,
      stepName: 'generate-plan',
      workflowInstanceId: 'wf-late-sess-001',
      originId: 'task-late-abc',
    })

    const spans = await spanStore.listSpans('task-late-abc')
    // sessionId was not set at openSpan time; closeSpan must have filled it.
    expect(spans[0].sessionId).toBe('sess-late')
  })
})
