/**
 * Tests for the `awaitHuman` primitive — the one park mechanism.
 *
 * `awaitHuman` delegates to the required `ctx.services.onManualPark` hook and
 * suspends until the operator runs `mars step done` (which calls
 * `resolveManualStep`). There is no sentinel throw any more, so a park is
 * driven to completion here by starting it, waiting for the resolver to
 * register, and then resolving it — see {@link parkAndRelease}.
 *
 * Coverage:
 *  1. `awaitHuman` parks the task through the default hook (stubbed store)
 *  2. previewUrl/logPath forwarding into the hook
 *  3. Restart-idempotency: after the daemon patches the step to 'completed',
 *     re-running the workflow short-circuits the step without re-parking.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { resolveManualStep } from '@mars/workflow'
import { AWAIT_HUMAN_SENTINEL } from '../../../core/lib/sentinels'

// ---------------------------------------------------------------------------
// 1. awaitHuman primitive — stubbed store + mocked side-effect imports
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
const { createDefaultManualPark } = await import('../../../core/lib/park-for-human')

/** Minimal TaskStore stub — only `query` (used by updateTask's before-read). */
const makeStubStore = () => ({
  query: vi.fn().mockResolvedValue({ rows: [{ status: 'running' }] }),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
  batch: vi.fn().mockResolvedValue([]),
})

/**
 * Minimal MarsCtx stub for testing awaitHuman, wired with the default park
 * hook — the same one every non-daemon services bag gets.
 */
const makeCtx = (stepName = 'await-human') => {
  const store = makeStubStore()
  return {
    runId: 'test-task-id',
    workflowId: 'task',
    input: { taskId: 'test-task-id' },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store,
      traceStore: null,
      onManualPark: createDefaultManualPark(store as never),
    },
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
  }
}

/**
 * Drive one park to completion: start the (suspending) park, poll until its
 * resolver is registered, then signal `mars step done`. Returns once the
 * primitive's promise settles, so the park's side effects have all landed.
 *
 * Polling on `resolveManualStep`'s own return value is what makes this
 * deterministic: it flips to `true` exactly when `awaitManualDone` has
 * registered, which is strictly after the park body finished.
 */
const parkAndRelease = async (
  start: () => Promise<unknown>,
  runId: string,
  stepName: string,
): Promise<void> => {
  const pending = start()
  await vi.waitFor(() => expect(resolveManualStep(runId, stepName)).toBe(true))
  await pending
}

describe('awaitHuman primitive', () => {
  beforeEach(() => {
    mockUpdateTask.mockClear()
    mockRaiseActionQueueItem.mockClear()
  })

  it('suspends until the operator signals step done, then returns normally', async () => {
    const ctx = makeCtx('await-human')
    const pending = awaitHuman(ctx as never)
    let settled = false
    void pending.then(() => {
      settled = true
    })

    // Still parked: nothing resolves the step yet.
    await vi.waitFor(() => expect(mockUpdateTask).toHaveBeenCalled())
    expect(settled).toBe(false)

    // `mars step done` — the park resolves and the step returns (no throw), so
    // runStep checkpoints it 'completed' itself.
    expect(resolveManualStep('test-task-id', 'await-human')).toBe(true)
    await expect(pending).resolves.toBeUndefined()
  })

  it('parks under the step name so `mars step done` can resolve it', async () => {
    const ctx = makeCtx('my-qa-gate')
    await parkAndRelease(() => awaitHuman(ctx as never), 'test-task-id', 'my-qa-gate')
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({ currentStepName: 'my-qa-gate' }),
      expect.anything(),
    )
  })

  it('calls updateTask with status=awaiting-human', async () => {
    const ctx = makeCtx('await-human')
    await parkAndRelease(() => awaitHuman(ctx as never), 'test-task-id', 'await-human')
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({ status: 'awaiting-human', leaseOwner: AWAIT_HUMAN_SENTINEL }),
      expect.anything(),
    )
  })

  it('passes note to leaseNote when provided', async () => {
    const ctx = makeCtx('await-human')
    await parkAndRelease(
      () => awaitHuman(ctx as never, { note: 'QA this feature' }),
      'test-task-id',
      'await-human',
    )
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({ leaseNote: 'QA this feature' }),
      expect.anything(),
    )
  })

  it('raises an action-queue row with kind=awaiting-human', async () => {
    const ctx = makeCtx('await-human')
    await parkAndRelease(() => awaitHuman(ctx as never), 'test-task-id', 'await-human')
    expect(mockRaiseActionQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'awaiting-human', originTaskId: 'test-task-id' }),
    )
  })

  it('falls back to "await-human" step name when currentStep is null', async () => {
    const ctx = makeCtx('my-step')
    ;(ctx as { currentStep: null }).currentStep = null
    await parkAndRelease(() => awaitHuman(ctx as never), 'test-task-id', 'await-human')
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({ currentStepName: 'await-human' }),
      expect.anything(),
    )
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
    await parkAndRelease(() => awaitHuman(ctx as never), 'test-task-id', 'code')
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
// 2. onManualPark delegation — previewUrl/logPath forwarding
// ---------------------------------------------------------------------------

describe('awaitHuman: onManualPark delegation', () => {
  beforeEach(() => {
    mockUpdateTask.mockClear()
    mockRaiseActionQueueItem.mockClear()
  })

  /** MarsCtx stub with an onManualPark hook wired, mirroring the daemon. */
  const makeCtxWithOnManualPark = (onManualPark: ReturnType<typeof vi.fn>) => ({
    ...makeCtx('await-human'),
    services: { store: makeStubStore(), traceStore: null, onManualPark },
  })

  it('delegates the whole park to onManualPark — no park body of its own', async () => {
    const onManualPark = vi.fn().mockResolvedValue(undefined)
    const ctx = makeCtxWithOnManualPark(onManualPark)
    await awaitHuman(ctx as never, { note: 'QA this' })
    expect(onManualPark).toHaveBeenCalledTimes(1)
    // awaitHuman is a thin delegation: every write happens inside the hook,
    // so a hook that writes nothing means nothing is written.
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
  })

  it('forwards previewUrl and logPath into the onManualPark call (the preview/QA gate)', async () => {
    const onManualPark = vi.fn().mockResolvedValue(undefined)
    const ctx = makeCtxWithOnManualPark(onManualPark)
    await awaitHuman(ctx as never, {
      note: 'QA this',
      previewUrl: 'http://localhost:3000',
      logPath: '/fake/.mars/previews/test-task-id.log',
    })
    expect(onManualPark).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'test-task-id',
        taskId: 'test-task-id',
        stepName: 'await-human',
        guide: 'QA this',
        previewUrl: 'http://localhost:3000',
        logPath: '/fake/.mars/previews/test-task-id.log',
      }),
    )
  })

  it('defaults previewUrl/logPath to null when not provided', async () => {
    const onManualPark = vi.fn().mockResolvedValue(undefined)
    const ctx = makeCtxWithOnManualPark(onManualPark)
    await awaitHuman(ctx as never)
    expect(onManualPark).toHaveBeenCalledWith(
      expect.objectContaining({ previewUrl: null, logPath: null }),
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
  _worktreePath: string,
  previewCmd: string | null,
  previewSpawn: (args: { taskId: string; cmd: string; cwd: string }) => Promise<{ pid: number; logPath: string; url?: string }>,
) => {
  const store = makeStubStore()
  return {
    runId: 'test-task-id',
    workflowId: 'task',
    input: {
      taskId: 'test-task-id',
      spec: previewCmd !== null ? { previewCmd } : null,
    },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store,
      traceStore: null,
      previewSpawn,
      onManualPark: createDefaultManualPark(store as never),
    },
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
  }
}

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
    await parkAndRelease(
      () => review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      'test-task-id',
      'review',
    )
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
    await parkAndRelease(
      () => review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      'test-task-id',
      'review',
    )
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
    await parkAndRelease(
      () => review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      'test-task-id',
      'review',
    )
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
    await parkAndRelease(
      () => review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      'test-task-id',
      'review',
    )
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

    // Models the daemon-restart window: the task parked, then the daemon died
    // with the in-memory resolver still pending, so the suspended step never
    // returns and the run ends 'failed'. handleStepDone Path 2 /
    // handleReleaseLease patch the step to 'completed' before re-queuing —
    // simulated below — and the engine must then short-circuit it.
    const minimalServices = {
      store: makeStubStore(),
      traceStore: null,
      onManualPark: () => Promise.reject(new Error('daemon restarted while parked')),
    }

    // First run: the park never completes → step ends in 'failed'.
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

    // Simulate handleStepDone / handleReleaseLease patching the step record to
    // 'completed' before re-queuing the task.
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

// ---------------------------------------------------------------------------
// 4. Live pipeline: code step uses awaitHuman (parks) not runAgent (coder)
// ---------------------------------------------------------------------------

describe('live pipeline code step transitions task to awaiting-human', () => {
  beforeEach(() => {
    mockUpdateTask.mockClear()
    mockRaiseActionQueueItem.mockClear()
  })

  it('awaitHuman in the code step parks the task to awaiting-human, not a worker span', async () => {
    // Replicate the fixed live-workflow code step shape: awaitHuman, not runAgent.
    // If runAgent were called here instead, it would not park the task — it
    // would dispatch a worker span and never set status=awaiting-human.
    const ctx = makeCtx('code')
    await parkAndRelease(
      () =>
        awaitHuman(ctx as never, {
          note: 'Implement the task in this worktree. Journal decisions with `mars task note`, tick done-criteria with `mars task check`, commit as you go, then run `mars step done`.',
        }),
      'test-task-id',
      'code',
    )
    // The task was parked — not dispatched to a headless coder.
    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-task-id',
      expect.objectContaining({ status: 'awaiting-human' }),
      expect.anything(),
    )
    // An action-queue row was raised so the operator sees the manual step.
    expect(mockRaiseActionQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'awaiting-human', originTaskId: 'test-task-id' }),
    )
  })
})

// ---------------------------------------------------------------------------
// 5. runAgent unknown-option rejection
// ---------------------------------------------------------------------------

describe('runAgent unknown-option rejection', () => {
  beforeEach(() => {
    mockUpdateTask.mockClear()
    mockRaiseActionQueueItem.mockClear()
  })

  it("throws when passed mode:'manual' (the former live-workflow anti-pattern)", async () => {
    const ctx = makeCtx('code')
    await expect(
      runAgent(ctx as never, { mode: 'manual' } as never),
    ).rejects.toThrow(/runAgent: unknown option\(s\) 'mode'/)
  })

  it("throws when passed guide (unknown key formerly used alongside mode:'manual')", async () => {
    const ctx = makeCtx('code')
    await expect(
      runAgent(ctx as never, { guide: 'Implement in worktree.' } as never),
    ).rejects.toThrow(/runAgent: unknown option\(s\) 'guide'/)
  })

  it('throws listing all unknown keys when multiple are passed', async () => {
    const ctx = makeCtx('code')
    const err = await runAgent(ctx as never, { mode: 'manual', guide: 'Implement.' } as never).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/'mode'/)
    expect((err as Error).message).toMatch(/'guide'/)
  })

  it('suggests awaitHuman as the remedy in the error message', async () => {
    const ctx = makeCtx('code')
    await expect(
      runAgent(ctx as never, { mode: 'manual' } as never),
    ).rejects.toThrow(/awaitHuman/)
  })

  it('does not throw for valid known options (dry-run mode returns inert result)', async () => {
    // Inject a validateRecorder so runAgent short-circuits after the unknown-key
    // guard — avoids real coder dispatch without a live daemon or worktree.
    const entries: unknown[] = []
    const ctx = {
      ...makeCtx('code'),
      services: {
        ...makeCtx('code').services,
        validateRecorder: { record: (e: unknown) => entries.push(e) },
      },
    }
    const result = await runAgent(ctx as never, { model: 'gpt-5-test' })
    expect(result).toEqual({ sessionId: null })
    // The recorder captured the runAgent declaration (auto mode, no guide).
    expect(entries.length).toBe(1)
    expect(entries[0]).toMatchObject({ primitive: 'runAgent', mode: 'auto', guide: null })
  })
})
