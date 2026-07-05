/**
 * Tests for the `awaitHuman` primitive and its sentinel helpers.
 *
 * Coverage:
 *  1. Sentinel helpers (pure) — AWAIT_HUMAN_MESSAGE, isAwaitHumanError,
 *     extractAwaitHumanStepName
 *  2. `awaitHuman` throws the sentinel and parks the task (stubbed store)
 *  3. Restart-idempotency: after the engine patches the step to 'completed',
 *     re-running the workflow short-circuits the step without re-parking.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  AWAIT_HUMAN_MESSAGE,
  isAwaitHumanError,
  extractAwaitHumanStepName,
} from '../shared'

// ---------------------------------------------------------------------------
// 1. Sentinel helpers (pure — no mocks needed)
// ---------------------------------------------------------------------------

describe('AWAIT_HUMAN_MESSAGE / isAwaitHumanError / extractAwaitHumanStepName', () => {
  it('AWAIT_HUMAN_MESSAGE embeds taskId and stepName', () => {
    const msg = AWAIT_HUMAN_MESSAGE('mars-abc12345', 'await-human')
    expect(msg).toContain('mars-abc12345')
    expect(msg).toContain("await-human step 'await-human'")
  })

  it('isAwaitHumanError recognises the sentinel', () => {
    const err = new Error(AWAIT_HUMAN_MESSAGE('task-1', 'my-step'))
    expect(isAwaitHumanError(err)).toBe(true)
  })

  it('isAwaitHumanError rejects unrelated errors', () => {
    expect(isAwaitHumanError(new Error('some other failure'))).toBe(false)
    expect(isAwaitHumanError(null)).toBe(false)
    expect(isAwaitHumanError('string error')).toBe(false)
  })

  it('isAwaitHumanError walks the cause chain', () => {
    const inner = new Error(AWAIT_HUMAN_MESSAGE('task-1', 'await-human'))
    const outer = new Error('wrapper', { cause: inner })
    expect(isAwaitHumanError(outer)).toBe(true)
  })

  it('extractAwaitHumanStepName returns the step name', () => {
    const err = new Error(AWAIT_HUMAN_MESSAGE('task-1', 'my-qa-gate'))
    expect(extractAwaitHumanStepName(err)).toBe('my-qa-gate')
  })

  it('extractAwaitHumanStepName extracts from a wrapped cause', () => {
    const inner = new Error(AWAIT_HUMAN_MESSAGE('task-1', 'qa-step'))
    const outer = new Error('outer wrapper', { cause: inner })
    expect(extractAwaitHumanStepName(outer)).toBe('qa-step')
  })

  it('extractAwaitHumanStepName returns null for non-sentinel errors', () => {
    expect(extractAwaitHumanStepName(new Error('unrelated'))).toBeNull()
    expect(extractAwaitHumanStepName(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. awaitHuman primitive — stubbed store + mocked side-effect imports
// ---------------------------------------------------------------------------

// Use vi.hoisted() so mocks are accessible in the vi.mock factory AND in tests.
const { mockUpdateTask, mockRaiseActionQueueItem } = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockRaiseActionQueueItem: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../core/queue', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../core/queue')>()
  return { ...original, updateTask: mockUpdateTask }
})

vi.mock('../../../core/lib/action-queue', () => ({
  raiseActionQueueItem: mockRaiseActionQueueItem,
}))

// Import the primitives AFTER the mocks are registered.
const { awaitHuman, runAgent, verify } = await import('../index')

/** Minimal TaskStore stub — only `query` (used by updateTask's before-read). */
const makeStubStore = () => ({
  query: vi.fn().mockResolvedValue({ rows: [{ status: 'running' }] }),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
  batch: vi.fn().mockResolvedValue([]),
})

/** Minimal MarsCtx stub for testing awaitHuman. */
const makeCtx = (stepName = 'await-human') => ({
  runId: 'test-task-id',
  workflowId: 'task',
  input: { taskId: 'test-task-id' },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  signal: new AbortController().signal,
  services: { store: makeStubStore(), traceStore: null },
  currentStep: stepName
    ? {
        name: stepName,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        signal: new AbortController().signal,
        setSha: vi.fn(),
        setTranscriptKey: vi.fn(),
        setSummary: vi.fn(),
      }
    : null,
  emit: vi.fn(),
  step: vi.fn(),
})

describe('awaitHuman primitive', () => {
  beforeEach(() => {
    mockUpdateTask.mockClear()
    mockRaiseActionQueueItem.mockClear()
  })

  it('throws an isAwaitHumanError-detectable error', async () => {
    const ctx = makeCtx('await-human')
    await expect(awaitHuman(ctx as never)).rejects.toSatisfy(isAwaitHumanError)
  })

  it('embeds the step name in the thrown sentinel', async () => {
    const ctx = makeCtx('my-qa-gate')
    let thrown: unknown
    try {
      await awaitHuman(ctx as never)
    } catch (err) {
      thrown = err
    }
    expect(extractAwaitHumanStepName(thrown)).toBe('my-qa-gate')
  })

  it('calls updateTask with status=awaiting-human', async () => {
    const ctx = makeCtx('await-human')
    await expect(awaitHuman(ctx as never)).rejects.toSatisfy(isAwaitHumanError)
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({ status: 'awaiting-human', leaseOwner: 'workflow:await-human' }),
      expect.anything(),
    )
  })

  it('passes note to leaseNote when provided', async () => {
    const ctx = makeCtx('await-human')
    await expect(
      awaitHuman(ctx as never, { note: 'QA this feature' }),
    ).rejects.toSatisfy(isAwaitHumanError)
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({ leaseNote: 'QA this feature' }),
      expect.anything(),
    )
  })

  it('raises an action-queue row with kind=awaiting-human', async () => {
    const ctx = makeCtx('await-human')
    await expect(awaitHuman(ctx as never)).rejects.toSatisfy(isAwaitHumanError)
    expect(mockRaiseActionQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'awaiting-human', originTaskId: 'test-task-id' }),
    )
  })

  it('falls back to "await-human" step name when currentStep is null', async () => {
    const ctx = makeCtx('my-step')
    ;(ctx as { currentStep: null }).currentStep = null
    let thrown: unknown
    try {
      await awaitHuman(ctx as never)
    } catch (err) {
      thrown = err
    }
    expect(extractAwaitHumanStepName(thrown)).toBe('await-human')
  })

  it('re-grants the lease to the prior human owner (auto re-lease across manual steps)', async () => {
    const ctx = makeCtx('code')
    // A full-enough task row for rowToTask: `mars step done` kept the human
    // lease owner on the row; the next manual park must re-grant to them.
    const row = {
      id: 'test-task-id',
      prompt: 'p',
      status: 'running',
      lease_owner: 'ilies@laptop',
      created_at: 't',
      updated_at: 't',
    }
    ;(ctx.services.store.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [row],
    })
    await expect(awaitHuman(ctx as never)).rejects.toSatisfy(isAwaitHumanError)
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({
        status: 'awaiting-human',
        leaseOwner: 'ilies@laptop',
      }),
      expect.anything(),
    )
  })
})

// ---------------------------------------------------------------------------
// 2b. Manual Execution mode on runAgent / verify (workflow-declared)
// ---------------------------------------------------------------------------

describe('manual Execution mode on primitives', () => {
  beforeEach(() => {
    mockUpdateTask.mockClear()
    mockRaiseActionQueueItem.mockClear()
  })

  it('runAgent mode:manual parks with the Step guide and never reaches the agent spawn', async () => {
    const ctx = makeCtx('code')
    ;(ctx as { input: unknown }).input = { taskId: 'test-task-id', prompt: 'p' }
    await expect(
      runAgent(ctx as never, { mode: 'manual', guide: 'iterate on the hero' }),
    ).rejects.toSatisfy(isAwaitHumanError)
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({
        status: 'awaiting-human',
        leaseNote: 'iterate on the hero',
      }),
      expect.anything(),
    )
  })

  it('verify mode:manual parks with the Step guide instead of running the gates', async () => {
    const ctx = makeCtx('verify')
    await expect(
      verify(ctx as never, { mode: 'manual', guide: 'QA in the browser' }),
    ).rejects.toSatisfy(isAwaitHumanError)
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({
        status: 'awaiting-human',
        leaseNote: 'QA in the browser',
      }),
      expect.anything(),
    )
  })
})

// ---------------------------------------------------------------------------
// 3. Restart-idempotency via engine + in-memory store
// ---------------------------------------------------------------------------

describe('awaitHuman idempotency via step-completion patch', () => {
  it('engine short-circuits the step after the daemon patches it to completed', async () => {
    const { runWorkflow } = await import('@mars/workflow')

    // Minimal in-memory WorkflowStore.
    type StepEntry = {
      status: string
      resultJson: string | null
      attempt: number
      startedAt: number
      finishedAt: number | null
      sha: null
      summary: null
      errorSummary: null
      transcriptKey: null
      seq: number
    }
    const runs = new Map<string, { status: string; inputJson: string }>()
    const steps = new Map<string, StepEntry>()
    const stepKey = (runId: string, name: string) => `${runId}::${name}`

    const memStore = {
      async createRun(run: { id: string; inputJson: string; status: string }) {
        if (!runs.has(run.id)) runs.set(run.id, { status: run.status, inputJson: run.inputJson })
      },
      async getRun(runId: string) {
        const r = runs.get(runId)
        if (!r) return undefined
        return {
          id: runId,
          workflowId: 'task',
          inputJson: r.inputJson,
          status: r.status,
          createdAt: 0,
          updatedAt: 0,
        }
      },
      async setRunStatus(runId: string, status: string) {
        const r = runs.get(runId)
        if (r) r.status = status
      },
      async getStep(runId: string, name: string) {
        const s = steps.get(stepKey(runId, name))
        if (!s) return undefined
        return { runId, name, ...s }
      },
      async listSteps(runId: string) {
        return Array.from(steps.entries())
          .filter(([k]) => k.startsWith(`${runId}::`))
          .map(([k, v]) => ({ runId, name: k.slice(runId.length + 2), ...v }))
          .sort((a, b) => a.seq - b.seq)
      },
      async putStep(record: {
        runId: string
        name: string
        status: string
        resultJson: string | null
        attempt: number
        startedAt: number
        finishedAt: number | null
        sha: null
        summary: null
        errorSummary: null
        transcriptKey: null
      }) {
        const k = stepKey(record.runId, record.name)
        const existing = steps.get(k)
        steps.set(k, {
          status: record.status,
          resultJson: record.resultJson,
          attempt: record.attempt,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          sha: null,
          summary: null,
          errorSummary: null,
          transcriptKey: null,
          seq: existing?.seq ?? steps.size,
        })
      },
      async deleteRun() {},
    }

    const taskId = 'idempotency-test-task'
    let parkCallCount = 0

    const innerFn = async (ctx: never) => {
      parkCallCount += 1
      await awaitHuman(ctx, { note: 'idempotency test' })
    }

    const minimalServices = { store: makeStubStore(), traceStore: null }

    // First run: awaitHuman parks and throws → step ends in 'failed'.
    const result1 = await runWorkflow(
      {
        id: 'task',
        fn: async (ctx) => ctx.step('await-human', () => innerFn(ctx as never)),
      },
      { taskId },
      { store: memStore as never, runId: taskId, services: minimalServices as never },
    )
    expect(result1.status).toBe('failed')
    expect(parkCallCount).toBe(1)

    // Simulate the daemon patching the step record to 'completed'.
    const failedStep = await memStore.getStep(taskId, 'await-human')
    expect(failedStep).toBeDefined()
    if (failedStep) {
      await memStore.putStep({
        ...failedStep,
        status: 'completed',
        finishedAt: Date.now(),
        resultJson: JSON.stringify({ parkedForHuman: true }),
      })
    }

    // Second run (after human releases lease → task re-dispatched).
    // Engine must short-circuit 'await-human' without invoking innerFn again.
    const result2 = await runWorkflow(
      {
        id: 'task',
        fn: async (ctx) => ctx.step('await-human', () => innerFn(ctx as never)),
      },
      { taskId },
      { store: memStore as never, runId: taskId, services: minimalServices as never },
    )
    // The workflow completes because the only step is short-circuited.
    expect(result2.status).toBe('completed')
    // innerFn was NOT called a second time — no double-park.
    expect(parkCallCount).toBe(1)
  })
})
