/**
 * The `token` Reflector runs on the Worker layer, not on a raw provider call.
 *
 * Observable behaviour under test — what an operator can actually see after a
 * `mars reflect` run:
 *
 *   1. The run is dispatched on the registered `Reflector` Worker, so its model
 *      comes from the ambient provider's fast tier (the same `defaultProvider`
 *      / `MARS_WORKER_PROVIDER` resolution every other Worker honours) rather
 *      than from an ad-hoc argument at the call site.
 *   2. The run lands in the event query path as a Session span carrying
 *      provider/model attribution — `workerName`, `provider`, `declaredTier`
 *      and `resolvedModel` on `step_started`, and a closing `step_ended`.
 *
 * Strategy: swap only the dispatched Worker's `run` (the subprocess boundary)
 * through the worker registry, keeping its REAL pinned config, and capture the
 * events with an in-memory trace store. Everything between the Port call and
 * the subprocess — registry lookup, span bracketing, tier resolution — is the
 * production code path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The reflector opens its own trace store (a reflect run is not a Task, so no
// caller hands it one). Feed it an in-memory recorder instead of a database.
const recorded = vi.hoisted(() => [] as Array<{ kind: string; payload: Record<string, unknown> }>)

vi.mock('../../../lib/trace-events-store', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../lib/trace-events-store')>()
  return {
    ...orig,
    openTraceEventStore: vi.fn().mockResolvedValue({
      record: async (event: { kind: string; payload?: Record<string, unknown> }) => {
        recorded.push({ kind: event.kind, payload: event.payload ?? {} })
      },
      close: async () => {},
    }),
  }
})

import { requireReflector } from '../registry'
import { registerWorker, requireWorker } from '../../../workers/worker-registry'
import type { Worker } from '../../../workers'
import type { ReflectCorpus } from '../../../lib/reflect-query'
import type { ReflectionResult } from '../../../lib/reflector'

const MODEL_OUTPUT = JSON.stringify({
  tokenAnalysis: {
    headline: 'nothing notable',
    tokenHeavyTasks: [],
    tokenHeavySteps: [],
    cacheHealth: null,
    successVsFailureTokens: null,
    notes: '',
  },
  suggestions: [],
})

const ONE_ENTRY_CORPUS: ReflectCorpus = {
  entries: [
    {
      taskId: 'fixture-1',
      status: 'done',
      promptPrefix: 'do the thing',
      errorTail: null,
      createdAt: '2026-05-01T00:00:00Z',
      failureSignature: null,
      failureReasonCode: null,
      failedPhase: null,
      kind: null,
      fixForTaskId: null,
      originId: null,
      toolErrorCount: 0,
      topErrorTool: null,
      baselineCaught: false,
      signals: [],
      scorerResults: [],
      totals: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        cacheHitRatio: 0,
      },
    },
  ],
  costSummary: {
    totalWeightedTokens: 0,
    taskCount: 1,
    successCount: 1,
    failureCount: 0,
    baselineCaughtCount: 0,
    blockedCount: 0,
    droppedCount: 0,
    cacheHitRatio: 0,
    rateLimitRejections: 0,
    topTokenHeavyTasks: [],
    topExpensiveSteps: [],
    tokensByStep: [],
  },
}

const reflect = (): Promise<ReflectionResult> =>
  requireReflector<ReflectCorpus, ReflectionResult>('token').reflect(ONE_ENTRY_CORPUS)

/** The real Reflector Worker, restored after each test. */
let realReflector: Worker
/** Prompts the stubbed Worker was dispatched with. */
let dispatchedPrompts: string[]

beforeEach(() => {
  recorded.length = 0
  dispatchedPrompts = []
  realReflector = requireWorker('Reflector')
  registerWorker({
    // REAL pinned config — the point of the test is that the attribution the
    // span carries comes from the registered Worker, not from the call site.
    config: realReflector.config,
    runtime: realReflector.runtime,
    run: async (prompt: string) => {
      dispatchedPrompts.push(prompt)
      return {
        stdout: MODEL_OUTPUT,
        stderr: '',
        conversation: [],
        exitCode: 0,
        sessionId: null,
        quotaRejected: null,
      }
    },
  } as Worker)
})

afterEach(() => {
  registerWorker(realReflector)
})

describe('token Reflector — Worker-layer routing', () => {
  it('dispatches the reflect prompt on the registered Reflector Worker', async () => {
    const result = await reflect()

    expect(dispatchedPrompts).toHaveLength(1)
    expect(dispatchedPrompts[0]).toContain('Token summary')
    expect(result.exitCode).toBe(0)
  })

  it('selects its model from the Reflector Worker config, not the call site', async () => {
    await reflect()

    const started = recorded.find((e) => e.kind === 'step_started')
    expect(started).toBeDefined()
    // The tier is declared by the Worker; the model is the ambient provider's
    // translation of that tier — the same path every other Worker takes.
    expect(started!.payload.declaredTier).toBe('fast')
    expect(started!.payload.resolvedModel).toBe(realReflector.config.model)
    expect(started!.payload.provider).toBe(realReflector.config.provider)
  })

  it('emits a closed Session span with provider/model attribution', async () => {
    await reflect()

    const started = recorded.find((e) => e.kind === 'step_started')
    const ended = recorded.find((e) => e.kind === 'step_ended')
    expect(started).toBeDefined()
    expect(ended).toBeDefined()

    // A Step span is a Session iff it names a worker — this one must.
    expect(started!.payload.workerName).toBe('Reflector')
    expect(ended!.payload.workerName).toBe('Reflector')
    expect(ended!.payload.provider).toBe(realReflector.config.provider)
    expect(ended!.payload.outcome).toBe('completed')
    // Both ends of the span share the step name the event query path filters on.
    expect(started!.payload.stepName).toBe('reflect')
    expect(ended!.payload.stepName).toBe('reflect')
  })
})
