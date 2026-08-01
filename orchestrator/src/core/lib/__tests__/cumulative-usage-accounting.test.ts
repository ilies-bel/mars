// Token accounting for a CUMULATIVE-usage provider (codex — the default
// Worker provider), end to end through the span wrapper.
//
// Three linked defects motivated these tests, all from reading Claude's
// per-request usage shape on every provider:
//   1. `usage_snapshots` recorded `{0,0,0,0}` every minute forever, so the
//      dispatch spend-control probe saw no spend at all.
//   2. `step_ended.usageSignals` were zero, so the window/arc token ceilings
//      (the operator budget controls) could never fire under codex either.
//   3. The in-run context ceiling is unenforceable on codex, and was withheld
//      SILENTLY — an operator had no way to see the ceiling was not armed.

import { chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runWorkerWithSpan } from '../run-worker-with-span'
import {
  getAccumulatedTotals,
  resetAccumulatedTotals,
} from '../../daemon/usage-accumulator'
import type { Worker, WorkerConfig, RunOptions } from '../../workers'
import type { RunClaudeResult } from '../git/claude'
import type { ClaudeEvent } from '../claude-stream'
import type { TraceEventStore } from '../trace-events-store'

// A real codex-cli 0.145.0 `turn.completed`, as parseCodexEventLine normalises
// it: the ONLY usage-bearing event on the whole stream.
const codexTurnCompleted: ClaudeEvent = {
  type: 'result',
  is_error: false,
  usage: {
    input_tokens: 31_864,
    cached_input_tokens: 25_088,
    cache_write_input_tokens: 0,
    output_tokens: 118,
    reasoning_output_tokens: 0,
  },
}

// Codex agent messages carry TEXT ONLY — no usage anywhere.
const codexAgentMessage: ClaudeEvent = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
}

const workerConfig = (
  provider: WorkerConfig['provider'],
  maxContextTokens: number,
): WorkerConfig => ({
  name: 'Coder',
  model: 'stub-model',
  effort: 'high',
  permissionMode: 'default',
  bare: false,
  disallowedTools: [],
  outputFormat: 'stream-json',
  maxContextTokens,
  runtime: 'headless',
  provider,
})

/** A Worker that streams `events` through onEvent, then returns them. */
const streamingWorker = (
  provider: WorkerConfig['provider'],
  events: readonly ClaudeEvent[],
  maxContextTokens = 200_000,
): Worker => ({
  config: workerConfig(provider, maxContextTokens),
  runtime: 'headless',
  run: async (_prompt: string, options: RunOptions): Promise<RunClaudeResult> => {
    for (const event of events) await options.onEvent?.(event)
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      sessionId: null,
      conversation: [...events],
      quotaRejected: null,
    }
  },
})

type Recorded = Parameters<TraceEventStore['record']>[0]

const recordingStore = (sink: Recorded[]): TraceEventStore =>
  ({
    record: async (event: Recorded) => {
      sink.push(event)
    },
  }) as unknown as TraceEventStore

const runSpan = async (worker: Worker, sink: Recorded[]): Promise<void> => {
  await runWorkerWithSpan({
    worker,
    prompt: 'do the thing',
    runOptions: { cwd: process.cwd() },
    traceStore: recordingStore(sink),
    stepName: 'run-claude-code',
    workflowInstanceId: 'wf-1',
    originId: 'mars-origin',
    taskId: 'mars-task',
    phase: 'code',
  })
}

const payloadOf = (sink: Recorded[], kind: string): Record<string, unknown> =>
  sink.find((e) => e.kind === kind)?.payload as Record<string, unknown>

describe('cumulative-provider token accounting', () => {
  beforeEach(() => {
    resetAccumulatedTotals()
  })
  afterEach(() => {
    resetAccumulatedTotals()
    vi.restoreAllMocks()
  })

  it('feeds the daemon spend meter from the terminal turn.completed usage', async () => {
    const sink: Recorded[] = []
    await runSpan(streamingWorker('codex', [codexAgentMessage, codexTurnCompleted]), sink)

    // Before the fix this was {0,0,0,0} — every row `usage_snapshots` ever wrote.
    expect(getAccumulatedTotals()).toEqual({
      inputTokens: 6_776,
      outputTokens: 118,
      cacheCreateTokens: 0,
      cacheReadTokens: 25_088,
    })
  })

  it('stamps real usageSignals on step_ended so the spend ceilings can see them', async () => {
    const sink: Recorded[] = []
    await runSpan(streamingWorker('codex', [codexAgentMessage, codexTurnCompleted]), sink)

    const signals = payloadOf(sink, 'step_ended').usageSignals as Record<string, number>
    expect(signals.inputTokens).toBe(6_776)
    expect(signals.outputTokens).toBe(118)
    expect(signals.cacheReadTokens).toBe(25_088)
    // Spend, never occupancy: nothing may divide this by a context window.
    expect(signals.cumulativeTokens).toBe(31_982)
    expect(signals.contextTokens).toBeUndefined()
  })

  it('declares the in-run ceiling inapplicable on both span events', async () => {
    const sink: Recorded[] = []
    await runSpan(streamingWorker('codex', [codexTurnCompleted]), sink)

    expect(payloadOf(sink, 'step_started').contextGuard).toBe('in-run-inapplicable')
    expect(payloadOf(sink, 'step_started').usageSemantics).toBe('cumulative')
    expect(payloadOf(sink, 'step_ended').contextGuard).toBe('in-run-inapplicable')
  })

  it('reports the ceiling as enforced for a per-request provider', async () => {
    const sink: Recorded[] = []
    const claudeAssistant: ClaudeEvent = {
      type: 'assistant',
      message: { usage: { input_tokens: 900, output_tokens: 100 }, content: [] },
    }
    await runSpan(streamingWorker('claude', [claudeAssistant]), sink)

    const ended = payloadOf(sink, 'step_ended')
    expect(ended.contextGuard).toBe('in-run-enforced')
    const signals = ended.usageSignals as Record<string, number>
    expect(signals.contextTokens).toBe(900)
    expect(signals.cumulativeTokens).toBeUndefined()
    expect(getAccumulatedTotals().inputTokens).toBe(900)
  })

  it('reports the ceiling as disabled when the worker configures no budget', async () => {
    const sink: Recorded[] = []
    await runSpan(streamingWorker('codex', [codexTurnCompleted], 0), sink)
    expect(payloadOf(sink, 'step_ended').contextGuard).toBe('disabled')
  })
})

// The unit tests above call runWorkerWithSpan with a stub Worker. That is not
// enough: production recorded zero while those tests passed, because the
// defect lived between the REAL dispatch chain and the accumulator. This suite
// spawns the real chain — createWorker → codexHeadless → runSubprocessStreaming
// → the span's onEvent — against a fake `codex` binary emitting a real event
// stream, and asserts the daemon's spend meter actually moved.
describe('the real dispatch path feeds the spend meter', () => {
  const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex-exec.mjs', import.meta.url))
  const originalBin = process.env.MARS_CODEX_BIN

  beforeEach(() => {
    chmodSync(fakeCodex, 0o755)
    process.env.MARS_CODEX_BIN = fakeCodex
    resetAccumulatedTotals()
  })
  afterEach(() => {
    if (originalBin === undefined) delete process.env.MARS_CODEX_BIN
    else process.env.MARS_CODEX_BIN = originalBin
    resetAccumulatedTotals()
  })

  it('records the run through a real createWorker + codex adapter dispatch', async () => {
    const { createWorker, WORKER_CONFIGS } = await import('../../workers')

    const worker = createWorker({ ...WORKER_CONFIGS.Coder, provider: 'codex' })
    const sink: Recorded[] = []
    const result = await runWorkerWithSpan({
      worker,
      prompt: 'do the thing',
      runOptions: { cwd: process.cwd() },
      traceStore: recordingStore(sink),
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-real',
      originId: 'origin-real',
      taskId: 'task-real',
      phase: 'code',
    })

    expect(result.exitCode).toBe(0)
    // The stream really did carry the terminal usage event...
    expect(result.conversation.some((e) => e.type === 'result')).toBe(true)
    // ...the span recorded it...
    const signals = payloadOf(sink, 'step_ended').usageSignals as Record<string, number>
    expect(signals.inputTokens).toBe(6_776)
    // ...and — the part production got wrong — so did the daemon's spend meter,
    // which is what `usage_snapshots` samples once a minute.
    expect(getAccumulatedTotals()).toEqual({
      inputTokens: 6_776,
      outputTokens: 118,
      cacheCreateTokens: 0,
      cacheReadTokens: 25_088,
    })
  })
})

describe('the inapplicable ceiling is announced, not silently withheld', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('warns once per dispatch on a cumulative provider, and never on Claude', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { createWorker, WORKER_CONFIGS } = await import('../../workers')
    const { PROVIDERS } = await import('../../workers/providers')

    const stub = async (): Promise<RunClaudeResult> => {
      throw new Error('stop')
    }
    const originals = {
      codex: PROVIDERS.codex.headless.run,
      claude: PROVIDERS.claude.headless.run,
    }
    ;(PROVIDERS.codex.headless as { run: unknown }).run = stub
    ;(PROVIDERS.claude.headless as { run: unknown }).run = stub
    try {
      const codexWorker = createWorker({ ...WORKER_CONFIGS.Coder, provider: 'codex' })
      await expect(codexWorker.run('hi', { cwd: process.cwd() })).rejects.toThrow('stop')
      const codexWarnings = warn.mock.calls.filter((c) =>
        String(c[0]).includes('in-run context ceiling NOT enforced'),
      )
      expect(codexWarnings).toHaveLength(1)
      expect(String(codexWarnings[0]![0])).toContain('codex')

      warn.mockClear()
      const claudeWorker = createWorker({ ...WORKER_CONFIGS.Coder, provider: 'claude' })
      await expect(claudeWorker.run('hi', { cwd: process.cwd() })).rejects.toThrow('stop')
      expect(
        warn.mock.calls.filter((c) => String(c[0]).includes('in-run context ceiling NOT enforced')),
      ).toHaveLength(0)
    } finally {
      ;(PROVIDERS.codex.headless as { run: unknown }).run = originals.codex
      ;(PROVIDERS.claude.headless as { run: unknown }).run = originals.claude
    }
  })
})
