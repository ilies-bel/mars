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
import { AWAIT_HUMAN_MESSAGE } from '../shared'
import { WorkflowTerminalError } from '../../../core/lib/workflow-terminal-error'
import { AWAIT_HUMAN_SENTINEL } from '../../../core/lib/sentinels'

// ---------------------------------------------------------------------------
// 1. Sentinel helpers (pure — no mocks needed)
// ---------------------------------------------------------------------------

describe('AWAIT_HUMAN_MESSAGE / WorkflowTerminalError await-human discriminant', () => {
  it('AWAIT_HUMAN_MESSAGE embeds taskId and stepName', () => {
    const msg = AWAIT_HUMAN_MESSAGE('mars-abc12345', 'await-human')
    expect(msg).toContain('mars-abc12345')
    expect(msg).toContain("await-human step 'await-human'")
  })

  it('WorkflowTerminalError await-human carries the correct kind and stepName in meta', () => {
    const err = new WorkflowTerminalError('await-human', AWAIT_HUMAN_MESSAGE('task-1', 'my-step'), { stepName: 'my-step' })
    expect(err).toBeInstanceOf(WorkflowTerminalError)
    expect(err.kind).toBe('await-human')
    expect(err.meta.stepName).toBe('my-step')
    expect(err.message).toContain('my-step')
  })

  it('plain Error is not instanceof WorkflowTerminalError', () => {
    const err = new Error(AWAIT_HUMAN_MESSAGE('task-1', 'my-step'))
    expect(err instanceof WorkflowTerminalError).toBe(false)
  })

  it('stepName defaults to undefined when not provided in meta', () => {
    const err = new WorkflowTerminalError('await-human', 'parked')
    expect(err.kind).toBe('await-human')
    expect(err.meta.stepName).toBeUndefined()
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
const { awaitHuman, runAgent, review } = await import('../index')

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

  it('throws a WorkflowTerminalError with kind=await-human', async () => {
    const ctx = makeCtx('await-human')
    await expect(awaitHuman(ctx as never)).rejects.toBeInstanceOf(WorkflowTerminalError)
    await expect(awaitHuman(ctx as never)).rejects.toSatisfy(
      (err: unknown) => err instanceof WorkflowTerminalError && err.kind === 'await-human',
    )
  })

  it('embeds the step name in the thrown sentinel via meta.stepName', async () => {
    const ctx = makeCtx('my-qa-gate')
    let thrown: unknown
    try {
      await awaitHuman(ctx as never)
    } catch (err) {
      thrown = err
    }
    expect(thrown instanceof WorkflowTerminalError ? thrown.meta.stepName : null).toBe('my-qa-gate')
  })

  it('calls updateTask with status=awaiting-human', async () => {
    const ctx = makeCtx('await-human')
    await expect(awaitHuman(ctx as never)).rejects.toBeInstanceOf(WorkflowTerminalError)
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({ status: 'awaiting-human', leaseOwner: AWAIT_HUMAN_SENTINEL }),
      expect.anything(),
    )
  })

  it('passes note to leaseNote when provided', async () => {
    const ctx = makeCtx('await-human')
    await expect(
      awaitHuman(ctx as never, { note: 'QA this feature' }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({ leaseNote: 'QA this feature' }),
      expect.anything(),
    )
  })

  it('raises an action-queue row with kind=awaiting-human', async () => {
    const ctx = makeCtx('await-human')
    await expect(awaitHuman(ctx as never)).rejects.toBeInstanceOf(WorkflowTerminalError)
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
    expect(thrown instanceof WorkflowTerminalError ? thrown.meta.stepName : null).toBe('await-human')
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
    await expect(awaitHuman(ctx as never)).rejects.toBeInstanceOf(WorkflowTerminalError)
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
// 2b. Manual reviewType on review (workflow-declared)
// ---------------------------------------------------------------------------

/**
 * Build a minimal MarsCtx for manual-review tests. Accepts:
 *   - worktreePath: injected directly via opts.worktree override
 *   - previewCmd: written into ctx.input.spec so the primitive picks it up
 *   - previewSpawn: fake spawn service injected via ctx.services
 */
const makeManualCtx = (
  worktreePath: string,
  previewCmd: string | null,
  previewSpawn: (args: { taskId: string; cmd: string; cwd: string }) => Promise<{ pid: number; logPath: string; url?: string }>,
) => ({
  runId: 'test-task-id',
  workflowId: 'task',
  input: {
    taskId: 'test-task-id',
    spec: previewCmd !== null ? { previewCmd } : null,
  },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  signal: new AbortController().signal,
  services: { store: makeStubStore(), traceStore: null, previewSpawn },
  currentStep: {
    name: 'review',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal,
    setSha: vi.fn(),
    setTranscriptKey: vi.fn(),
    setSummary: vi.fn(),
  },
  emit: vi.fn(),
  step: vi.fn(),
})

describe('review with reviewType:manual', () => {
  const fakeWorktree = { path: '/fake/worktree', branch: 'task/test-task-id' }

  beforeEach(() => {
    mockUpdateTask.mockClear()
    mockRaiseActionQueueItem.mockClear()
  })

  it('calls previewSpawn with the worktree cwd', async () => {
    const mockSpawn = vi.fn().mockResolvedValue({
      pid: 1234,
      logPath: '/fake/.mars/previews/test-task-id.log',
      url: 'http://localhost:3000',
    })
    const ctx = makeManualCtx('/fake/worktree', 'npm run dev', mockSpawn)
    await expect(
      review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/fake/worktree', cmd: 'npm run dev', taskId: 'test-task-id' }),
    )
  })

  it('the awaiting-human row payload carries previewUrl and logPath', async () => {
    const mockSpawn = vi.fn().mockResolvedValue({
      pid: 1234,
      logPath: '/fake/.mars/previews/test-task-id.log',
      url: 'http://localhost:3000',
    })
    const ctx = makeManualCtx('/fake/worktree', 'npm run dev', mockSpawn)
    await expect(
      review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)
    expect(mockRaiseActionQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'awaiting-human',
        payload: expect.objectContaining({
          previewUrl: 'http://localhost:3000',
          logPath: '/fake/.mars/previews/test-task-id.log',
        }),
      }),
    )
  })

  it('parks via awaitHuman (transitions task to awaiting-human)', async () => {
    const mockSpawn = vi.fn().mockResolvedValue({
      pid: 1234,
      logPath: '/fake/.mars/previews/test-task-id.log',
      url: 'http://localhost:3000',
    })
    const ctx = makeManualCtx('/fake/worktree', 'npm run dev', mockSpawn)
    await expect(
      review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({ status: 'awaiting-human' }),
      expect.anything(),
    )
  })

  it('errors with a descriptive message when no previewCmd and no package.json', async () => {
    // No previewCmd on spec; no package.json at /fake/worktree (path does not exist).
    const mockSpawn = vi.fn()
    const ctx = makeManualCtx('/fake/worktree', null, mockSpawn)
    await expect(
      review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
    ).rejects.toThrow('manual review: no preview command found for task')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('omits previewUrl from payload when spawn returns no url', async () => {
    const mockSpawn = vi.fn().mockResolvedValue({
      pid: 1234,
      logPath: '/fake/.mars/previews/test-task-id.log',
      // url intentionally absent
    })
    const ctx = makeManualCtx('/fake/worktree', 'npm run dev', mockSpawn)
    await expect(
      review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)
    expect(mockRaiseActionQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          logPath: '/fake/.mars/previews/test-task-id.log',
        }),
      }),
    )
    // previewUrl must not appear in the payload (null check via spreading —
    // the payload should not have previewUrl key when url is undefined).
    const call = mockRaiseActionQueueItem.mock.calls[0] as [{ payload: Record<string, unknown> }]
    expect(call[0].payload.previewUrl).toBeUndefined()
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
