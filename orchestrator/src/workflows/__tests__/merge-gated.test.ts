/**
 * Integration test: tasks with merge_mode='gated' must not reach status
 * 'done' without an explicit operator approval gesture.
 *
 * Regression for: gated tasks silently merging because the implement
 * workflow never checked spec.mergeMode before entering the merge step.
 *
 * Coverage:
 *  1. With merge_mode='gated', the workflow suspends at 'merge-gate' — the
 *     task is parked in 'awaiting-human', an action-queue row is raised, and
 *     the merge primitive is not called until the operator resolves the step.
 *  2. If the daemon dies while the gate is suspended, patching the
 *     'merge-gate' step to 'completed' (what `mars step done` Path 2 does)
 *     makes a re-dispatch short-circuit the gate and proceed to merge.
 *  3. With merge_mode='auto' (or no spec), the workflow skips the gate and
 *     calls merge directly — no parking.
 *
 * Since PRD ae17340a-modular-core-program-make-every-mars-mod slice 27 there
 * is exactly ONE park mechanism: `awaitHuman` delegates to the required
 * `services.onManualPark`, which parks and then suspends on
 * `awaitManualDone(runId, stepName)`. The gate no longer throws a terminal
 * sentinel, so a gated run stays in-flight rather than ending 'failed'.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AWAIT_HUMAN_SENTINEL } from '../../core/lib/sentinels'

// ---------------------------------------------------------------------------
// Hoist mocks — must be hoisted so the vi.mock factories can close over them.
// ---------------------------------------------------------------------------

const { mockUpdateTask, mockRaiseActionQueueItem } = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockRaiseActionQueueItem: vi.fn().mockResolvedValue(undefined),
}))

// Mocked fast-path primitives (setup, code, review, behaviourVerify, merge).
// These are replaced in the primitives module so implementWorkflow calls them
// when it runs the corresponding ctx.step bodies.
const mockSetupWorktree = vi.fn().mockResolvedValue(undefined)
const mockRunAgent = vi.fn().mockResolvedValue(undefined)
const mockReview = vi.fn().mockResolvedValue(undefined)
const mockBehaviourVerify = vi.fn().mockResolvedValue(undefined)
const mockMerge = vi.fn().mockResolvedValue({
  taskId: 'gated-task-id',
  success: true,
  message: 'merged',
})

// ---------------------------------------------------------------------------
// Module mocks — registered BEFORE any dynamic import below.
// ---------------------------------------------------------------------------

// Replace fast-path primitives; leave awaitHuman as-is so it runs naturally
// (with its own side effects mocked separately below).
vi.mock('../primitives', async (importOriginal) => {
  const original = await importOriginal<typeof import('../primitives')>()
  return {
    ...original,
    setupWorktree: mockSetupWorktree,
    runAgent: mockRunAgent,
    review: mockReview,
    merge: mockMerge,
  }
})

// behaviourVerify is imported from its own sub-module in implement-workflow.
vi.mock('../primitives/behaviour-verify', () => ({
  behaviourVerify: mockBehaviourVerify,
}))

// Mock updateTask side-effect so awaitHuman can transition the task row.
vi.mock('../../core/queue', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../core/queue')>()
  return { ...original, updateTask: mockUpdateTask }
})

// Mock raiseActionQueueItem side-effect so awaitHuman doesn't hit the DB.
vi.mock('../../core/lib/action-queue', () => ({
  raiseActionQueueItem: mockRaiseActionQueueItem,
}))

// ---------------------------------------------------------------------------
// Dynamic imports — must come AFTER vi.mock() calls.
// ---------------------------------------------------------------------------

const { runWorkflow, resolveManualStep } = await import('@mars/workflow')
const { implementWorkflow, implementInputSchema } = await import('../implement-workflow')
const { createDefaultManualPark } = await import('../../core/lib/park-for-human')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal in-memory WorkflowStore used by runWorkflow. */
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

function makeMemStore() {
  const runs = new Map<string, { status: string; inputJson: string }>()
  const steps = new Map<string, StepEntry>()
  const stepKey = (runId: string, name: string) => `${runId}::${name}`

  return {
    async createRun(run: { id: string; inputJson: string; status: string }) {
      if (!runs.has(run.id)) {
        runs.set(run.id, { status: run.status, inputJson: run.inputJson })
      }
    },
    async getRun(runId: string) {
      const r = runs.get(runId)
      if (!r) return undefined
      return {
        id: runId,
        workflowId: 'implement',
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
    // Expose step map for test introspection / mutation.
    _steps: steps,
    _stepKey: stepKey,
  }
}

/** Minimal task-store stub for services.store (used by the park side-effects). */
const makeTaskStoreStub = () => ({
  query: vi.fn().mockResolvedValue({ rows: [{ id: 'gated-task-id', status: 'running' }] }),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
  batch: vi.fn().mockResolvedValue([]),
})

/**
 * MarsServices bag with the real default park hook bound to the stub store —
 * the same hook the daemon installs, so the gate exercises the production park
 * body (updateTask + raiseActionQueueItem, both mocked above) and then suspends
 * on `awaitManualDone` until `resolveManualStep` fires.
 */
const makeServices = (taskStore: ReturnType<typeof makeTaskStoreStub>) => ({
  store: taskStore,
  traceStore: null,
  onManualPark: createDefaultManualPark(taskStore as never),
})

/**
 * Release a suspended gate the way `mars step done` Path 1 does, retrying
 * until the park has registered its resolver (the park raises its row a few
 * microtasks before `awaitManualDone` registers).
 */
const releaseGate = async (runId: string): Promise<void> => {
  await vi.waitFor(() => expect(resolveManualStep(runId, 'merge-gate')).toBe(true), {
    timeout: 2000,
  })
}

/** Minimal valid workflow input with merge_mode='gated'.
 *
 * Parsed through implementInputSchema so schema-provided defaults (plan, tags,
 * kind, integrationBranch, resumeFromPriorAttempt, verifyFailureOutput,
 * recoveryPayload, fixForTaskId, qa, and spec.readFirst / spec.prescriptiveAction)
 * are filled in — otherwise the object is not assignable to ImplementInput. */
const gatedInput = implementInputSchema.parse({
  taskId: 'gated-task-id',
  prompt: 'implement the gated feature',
  spec: {
    files: [],
    verifyCmd: null,
    doneCriteria: [],
    mergeMode: 'gated' as const,
  },
})

/** Minimal valid workflow input with merge_mode='auto'. */
const autoInput = implementInputSchema.parse({
  taskId: 'auto-task-id',
  prompt: 'implement the auto feature',
  spec: {
    files: [],
    verifyCmd: null,
    doneCriteria: [],
    mergeMode: 'auto' as const,
  },
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('merge_mode=gated gate', () => {
  beforeEach(() => {
    mockUpdateTask.mockClear()
    mockRaiseActionQueueItem.mockClear()
    mockSetupWorktree.mockClear()
    mockRunAgent.mockClear()
    mockReview.mockClear()
    mockBehaviourVerify.mockClear()
    mockMerge.mockClear()
  })

  it('gated task parks at merge-gate — merge waits for the operator, then runs', async () => {
    const store = makeMemStore()
    const taskStore = makeTaskStoreStub()

    // The gate suspends, so the run stays in flight until the gate is released.
    const resultPromise = runWorkflow(
      implementWorkflow,
      gatedInput,
      {
        store: store as never,
        runId: 'gated-task-id',
        services: makeServices(taskStore) as never,
      },
    )

    // Wait for the park to land its action-queue row.
    await vi.waitFor(() => expect(mockRaiseActionQueueItem).toHaveBeenCalled(), { timeout: 2000 })

    // The task must have been transitioned to 'awaiting-human', NOT 'done'.
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'gated-task-id',
      expect.objectContaining({ status: 'awaiting-human', leaseOwner: expect.any(String) }),
      expect.anything(),
    )
    const doneCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'done',
    )
    expect(doneCalls).toHaveLength(0)

    // An action-queue row must have been raised for the operator.
    expect(mockRaiseActionQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'awaiting-human', originTaskId: 'gated-task-id' }),
    )

    // The merge primitive must NOT have been called while the gate is parked.
    expect(mockMerge).not.toHaveBeenCalled()

    // The preceding steps all ran — gate fires after verify, not before.
    expect(mockSetupWorktree).toHaveBeenCalledTimes(1)
    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    expect(mockReview).toHaveBeenCalledTimes(1)
    expect(mockBehaviourVerify).toHaveBeenCalledTimes(1)

    // The operator approves — only now does the merge run.
    await releaseGate('gated-task-id')
    const result = await resultPromise
    expect(result.status).toBe('completed')
    expect(mockMerge).toHaveBeenCalledTimes(1)
  })

  it('after operator patches merge-gate to completed, re-dispatch calls merge and completes', async () => {
    const store = makeMemStore()
    const taskStore = makeTaskStoreStub()
    const runOpts = {
      store: store as never,
      runId: 'gated-task-id',
      services: {
        store: taskStore,
        traceStore: null,
        // The daemon dies while the gate is suspended: the step never
        // checkpoints, so runStep records it 'failed'. That is exactly the
        // pre-state `mars step done` Path 2 patches before re-queuing.
        onManualPark: (): Promise<void> =>
          Promise.reject(new Error('daemon died while the merge-gate park was suspended')),
      } as never,
    }

    // First dispatch: reaches the gate and does not merge.
    const result1 = await runWorkflow(implementWorkflow, gatedInput, runOpts)
    expect(result1.status).toBe('failed')
    expect(mockMerge).not.toHaveBeenCalled()

    // Simulate `mars step done`: the daemon patches merge-gate to 'completed'.
    const gateKey = store._stepKey('gated-task-id', 'merge-gate')
    const gateStep = store._steps.get(gateKey)
    expect(gateStep).toBeDefined()
    store._steps.set(gateKey, {
      ...gateStep!,
      status: 'completed',
      finishedAt: Date.now(),
      resultJson: JSON.stringify({ parkedForHuman: true }),
    })

    // Clear mocks before the second run so we count only the new calls.
    mockUpdateTask.mockClear()
    mockRaiseActionQueueItem.mockClear()
    mockMerge.mockClear()

    // Second run (re-dispatch after approval): merge-gate is short-circuited,
    // so the rejecting hook above is never reached again.
    const result2 = await runWorkflow(implementWorkflow, gatedInput, runOpts)

    // The workflow must complete successfully.
    expect(result2.status).toBe('completed')

    // The merge primitive must have been called this time.
    expect(mockMerge).toHaveBeenCalledTimes(1)

    // The gate must NOT have parked again (no double-park).
    expect(mockUpdateTask).not.toHaveBeenCalledWith(
      'gated-task-id',
      expect.objectContaining({ status: 'awaiting-human' }),
      expect.anything(),
    )
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
  })

  it('merge_mode=auto task skips the gate entirely and calls merge directly', async () => {
    const store = makeMemStore()
    const taskStore = makeTaskStoreStub()

    const result = await runWorkflow(
      implementWorkflow,
      autoInput,
      {
        store: store as never,
        runId: 'auto-task-id',
        services: makeServices(taskStore) as never,
      },
    )

    // Auto tasks must complete without parking.
    expect(result.status).toBe('completed')

    // Merge must have been called.
    expect(mockMerge).toHaveBeenCalledTimes(1)

    // No awaiting-human transition, no action-queue row.
    expect(mockUpdateTask).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'awaiting-human' }),
      expect.anything(),
    )
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
  })

  it('gated task with no spec does NOT park (spec defaults to null → auto)', async () => {
    const store = makeMemStore()
    const taskStore = makeTaskStoreStub()

    const noSpecInput = implementInputSchema.parse({
      taskId: 'no-spec-task-id',
      prompt: 'implement without spec',
      // spec omitted → defaults to null inside implementInputSchema
    })

    const result = await runWorkflow(
      implementWorkflow,
      noSpecInput,
      {
        store: store as never,
        runId: 'no-spec-task-id',
        services: makeServices(taskStore) as never,
      },
    )

    expect(result.status).toBe('completed')
    expect(mockMerge).toHaveBeenCalledTimes(1)
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
  })

  it('leaseOwner in awaiting-human row is the AWAIT_HUMAN_SENTINEL (no prior human owner)', async () => {
    const store = makeMemStore()
    // Store returns a row with no lease_owner so the park falls back to the
    // sentinel identity rather than re-granting a prior human's lease.
    const taskStore = makeTaskStoreStub()

    const resultPromise = runWorkflow(
      implementWorkflow,
      gatedInput,
      {
        store: store as never,
        runId: 'gated-task-id',
        services: makeServices(taskStore) as never,
      },
    )

    await vi.waitFor(
      () =>
        expect(mockUpdateTask).toHaveBeenCalledWith(
          'gated-task-id',
          expect.objectContaining({
            status: 'awaiting-human',
            leaseOwner: AWAIT_HUMAN_SENTINEL,
          }),
          expect.anything(),
        ),
      { timeout: 2000 },
    )

    await releaseGate('gated-task-id')
    await resultPromise
  })
})
