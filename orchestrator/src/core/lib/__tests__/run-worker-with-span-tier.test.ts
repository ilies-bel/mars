// Unit tests for the modelTier override on runWorkerWithSpan (Phase 4B slice 1).
//
// Four cases:
//   (a) override → resolved model swap (worker.config.model is NOT used)
//   (b) no-override → pinned model passthrough (worker.config.model IS used)
//   (c) declaredTier + resolvedModel appear on the step_started event
//   (d) unknown tier value throws with an actionable message

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openTraceEventStore } from '../trace-events-store'
import { runWorkerWithSpan } from '../run-worker-with-span'
import { PROVIDER_MODELS, type ProviderModelTier } from '../../workers/provider-types'
import type { Worker, WorkerConfig, RunOptions } from '../../workers'
import type { RunClaudeResult } from '../git/claude'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-tier-test-'))
  return join(dir, 'mars.db')
}

// Minimal WorkerConfig stub. Uses the claude provider so tier lookups are
// deterministic regardless of MARS_WORKER_PROVIDER in the environment.
const makeWorkerConfig = (overrides: Partial<WorkerConfig> = {}): WorkerConfig => ({
  name: 'Coder',
  model: 'claude-sonnet-4-6',
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
})

// A Worker that captures the model it was dispatched with via RunOptions.model.
// Returns the captured model in a side-channel so tests can assert on it.
const makeCapturingWorker = (
  config: WorkerConfig,
  capturedModel: { value: string | undefined },
): Worker => ({
  config,
  runtime: 'headless',
  run: async (_prompt: string, options: RunOptions): Promise<RunClaudeResult> => {
    capturedModel.value = options.model
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    }
  },
})

// ── (a) override → resolved model swap ───────────────────────────────────────

describe('runWorkerWithSpan modelTier override', () => {
  it('(a) dispatches the tier-resolved model, not worker.config.model, when modelTier is given', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const capturedModel: { value: string | undefined } = { value: undefined }

    // Worker is pinned to balanced (claude-sonnet-4-6); caller requests fast.
    const config = makeWorkerConfig({ model: 'claude-sonnet-4-6', modelTier: 'balanced' })
    const worker = makeCapturingWorker(config, capturedModel)

    await runWorkerWithSpan({
      worker,
      prompt: 'implement the thing',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-tier-override-001',
      originId: 'task-tier-override',
      taskId: 'task-tier-override',
      modelTier: 'fast',
    })

    // The resolved model must be the fast-tier model for the claude provider.
    const expectedFastModel = PROVIDER_MODELS['claude']['fast']
    expect(capturedModel.value).toBe(expectedFastModel)
    // Sanity: the fast model is different from the balanced pin.
    expect(capturedModel.value).not.toBe('claude-sonnet-4-6')
  })

  it('(a) worker.config.model is not mutated by the tier override', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const capturedModel: { value: string | undefined } = { value: undefined }
    const config = makeWorkerConfig({ model: 'claude-sonnet-4-6' })
    const worker = makeCapturingWorker(config, capturedModel)
    const pinnedModelBefore = worker.config.model

    await runWorkerWithSpan({
      worker,
      prompt: 'implement',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-nomutate-001',
      originId: 'task-nomutate',
      taskId: 'task-nomutate',
      modelTier: 'flagship',
    })

    // The pinned model on config must not have changed.
    expect(worker.config.model).toBe(pinnedModelBefore)
    // The dispatched model is the flagship resolution, not the pinned balanced.
    expect(capturedModel.value).toBe(PROVIDER_MODELS['claude']['flagship'])
  })
})

// ── (b) no-override → pinned model passthrough ───────────────────────────────

describe('runWorkerWithSpan no modelTier', () => {
  it('(b) dispatches worker.config.model unchanged when no modelTier is given', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const capturedModel: { value: string | undefined } = { value: undefined }
    const config = makeWorkerConfig({ model: 'claude-sonnet-4-6' })
    const worker = makeCapturingWorker(config, capturedModel)

    await runWorkerWithSpan({
      worker,
      prompt: 'implement',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-nooverride-001',
      originId: 'task-nooverride',
      taskId: 'task-nooverride',
      // modelTier deliberately omitted
    })

    expect(capturedModel.value).toBe('claude-sonnet-4-6')
  })
})

// ── (c) declaredTier + resolvedModel on step_started ─────────────────────────

describe('runWorkerWithSpan step_started tier fields', () => {
  it('(c) step_started carries declaredTier=fast and resolvedModel=fast-model when override given', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const config = makeWorkerConfig({ model: 'claude-sonnet-4-6', modelTier: 'balanced' })
    const capturedModel: { value: string | undefined } = { value: undefined }
    const worker = makeCapturingWorker(config, capturedModel)

    await runWorkerWithSpan({
      worker,
      prompt: 'implement',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-stepstarted-tier-001',
      originId: 'task-stepstarted-tier',
      taskId: 'task-stepstarted-tier',
      modelTier: 'fast',
    })

    const started = (
      await traceStore.query({ taskId: 'task-stepstarted-tier', kind: ['step_started'] })
    )[0]
    expect(started).toBeDefined()
    expect(started!.payload.declaredTier).toBe('fast')
    expect(started!.payload.resolvedModel).toBe(PROVIDER_MODELS['claude']['fast'])
  })

  it('(c) step_started carries declaredTier=balanced (from config) and resolvedModel=pinned when no override', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const config = makeWorkerConfig({ model: 'claude-sonnet-4-6', modelTier: 'balanced' })
    const capturedModel: { value: string | undefined } = { value: undefined }
    const worker = makeCapturingWorker(config, capturedModel)

    await runWorkerWithSpan({
      worker,
      prompt: 'implement',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-stepstarted-notier-001',
      originId: 'task-stepstarted-notier',
      taskId: 'task-stepstarted-notier',
      // no modelTier
    })

    const started = (
      await traceStore.query({ taskId: 'task-stepstarted-notier', kind: ['step_started'] })
    )[0]
    expect(started).toBeDefined()
    // declaredTier falls back to worker.config.modelTier when no override
    expect(started!.payload.declaredTier).toBe('balanced')
    // resolvedModel is the Worker's pinned model when no override
    expect(started!.payload.resolvedModel).toBe('claude-sonnet-4-6')
  })

  it('(c) step_started carries declaredTier=null when no override and config has no modelTier', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    // WorkerConfig with no modelTier set
    const config = makeWorkerConfig({ model: 'claude-sonnet-4-6', modelTier: undefined })
    const capturedModel: { value: string | undefined } = { value: undefined }
    const worker = makeCapturingWorker(config, capturedModel)

    await runWorkerWithSpan({
      worker,
      prompt: 'implement',
      runOptions: { cwd: '/tmp' },
      traceStore,
      stepName: 'run-claude-code',
      workflowInstanceId: 'wf-stepstarted-nulltier-001',
      originId: 'task-stepstarted-nulltier',
      taskId: 'task-stepstarted-nulltier',
    })

    const started = (
      await traceStore.query({ taskId: 'task-stepstarted-nulltier', kind: ['step_started'] })
    )[0]
    expect(started!.payload.declaredTier).toBeNull()
    expect(started!.payload.resolvedModel).toBe('claude-sonnet-4-6')
  })
})

// ── (d) unknown tier → actionable throw ──────────────────────────────────────

describe('runWorkerWithSpan unknown modelTier', () => {
  it('(d) throws with an actionable message when an unknown tier string is passed', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const config = makeWorkerConfig()
    const capturedModel: { value: string | undefined } = { value: undefined }
    const worker = makeCapturingWorker(config, capturedModel)

    // Cast bypasses TypeScript so we can test the runtime guard.
    await expect(
      runWorkerWithSpan({
        worker,
        prompt: 'implement',
        runOptions: { cwd: '/tmp' },
        traceStore,
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-badtier-001',
        originId: 'task-badtier',
        taskId: 'task-badtier',
        modelTier: 'ultra' as ProviderModelTier,
      }),
    ).rejects.toThrow(/unknown modelTier 'ultra'/)

    // Worker.run must NOT have been called — the guard fires before dispatch.
    expect(capturedModel.value).toBeUndefined()
  })

  it('(d) error message names the provider and valid tiers', async () => {
    const traceStore = await openTraceEventStore(tmpDbPath())
    const config = makeWorkerConfig({ provider: 'claude' })
    const capturedModel: { value: string | undefined } = { value: undefined }
    const worker = makeCapturingWorker(config, capturedModel)

    await expect(
      runWorkerWithSpan({
        worker,
        prompt: 'implement',
        runOptions: { cwd: '/tmp' },
        traceStore,
        stepName: 'run-claude-code',
        workflowInstanceId: 'wf-badtier-002',
        originId: 'task-badtier-2',
        taskId: 'task-badtier-2',
        modelTier: 'turbo' as ProviderModelTier,
      }),
    ).rejects.toThrow(/provider 'claude'/)
  })
})
