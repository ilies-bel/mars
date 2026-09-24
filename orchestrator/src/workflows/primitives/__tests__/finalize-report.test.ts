/**
 * Tests for the `finalizeReport` primitive.
 *
 * Verifies that finalizeReport:
 *   1. Removes the task's worktree via `removeWorktree`.
 *   2. Transitions the task row to status='done', failedPhase=null via
 *      updateTask / ctx.services.store (ADR-0052).
 *   3. Returns { taskId, success: true, message: 'report complete' }.
 *   4. Never touches the merge lock, never emits vcs-supervisor events,
 *      and never calls mergeBranch or checkMergeTargetStatus.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetContextCacheForTests } from '../../../core/context'

// ---------------------------------------------------------------------------
// Hoisted mocks — accessible inside vi.mock() factories AND in test bodies.
// ---------------------------------------------------------------------------

const {
  mockUpdateTask,
  mockGetTask,
  mockRemoveWorktree,
  mockMergeBranch,
  mockCheckMergeTargetStatus,
  mockAppendProgress,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockGetTask: vi.fn().mockResolvedValue(null),
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
  mockMergeBranch: vi.fn(),
  mockCheckMergeTargetStatus: vi.fn(),
  mockAppendProgress: vi.fn().mockResolvedValue({
    id: 'prog-test',
    taskId: '',
    createdAt: 0,
    author: 'orchestrator',
    kind: 'note' as const,
    body: '',
    criterionIndex: null,
  }),
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return { ...orig, updateTask: mockUpdateTask, getTask: mockGetTask }
})

vi.mock('../../../core/lib/git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/worktree')>()
  return { ...orig, removeWorktree: mockRemoveWorktree }
})

vi.mock('../../../core/lib/git/merge', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/merge')>()
  return {
    ...orig,
    mergeBranch: mockMergeBranch,
    checkMergeTargetStatus: mockCheckMergeTargetStatus,
  }
})

vi.mock('../../../core/context', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/context')>()
  return {
    ...orig,
    resolveContext: () => ({
      repoRoot: '/tmp/test-repo',
      stateDir: '/tmp/test-repo/.mars',
      supervisorsManifest: [],
    }),
    getStateDir: () => '/tmp/test-repo/.mars',
    getRepoRoot: () => '/tmp/test-repo',
  }
})

vi.mock('../../../core/lib/origin', () => ({
  resolveOriginIdForTask: async (id: string) => id,
  Arc: { load: () => ({ originId: null }) },
}))

vi.mock('../../../core/lib/run-worker-with-span', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/run-worker-with-span')>()
  return {
    ...orig,
    runNonLlmStepWithSpan: async <T>(opts: { fn: () => Promise<T> }) => opts.fn(),
  }
})

vi.mock('../../../core/queue-fix-tasks', () => ({
  handleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
}))

vi.mock('../../../core/lib/action-queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/action-queue')>()
  return { ...orig, raiseActionQueueItem: vi.fn().mockResolvedValue('aq-id') }
})

vi.mock('../../../core/arc', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/arc')>()
  // Replace only the Arc.appendProgress static method so the existing
  // queue/store/updateTask mocks are unaffected by this module mock.
  return {
    ...orig,
    Arc: {
      appendProgress: mockAppendProgress,
    },
  }
})

// ---------------------------------------------------------------------------
// Import module under test AFTER vi.mock() hoisting is complete.
// ---------------------------------------------------------------------------

const { finalizeReport } = await import('../index')

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

beforeEach(() => {
  process.env.MARS_REPO = '/tmp/test-repo'
  __resetContextCacheForTests()
  vi.clearAllMocks()
  mockGetTask.mockResolvedValue(null)
  mockRemoveWorktree.mockResolvedValue(undefined)
  mockUpdateTask.mockResolvedValue(undefined)
  mockAppendProgress.mockResolvedValue({
    id: 'prog-test',
    taskId: '',
    createdAt: 0,
    author: 'orchestrator',
    kind: 'note' as const,
    body: '',
    criterionIndex: null,
  })
})

/** Minimal MarsCtx stub. Pass `opts.worktree` to bypass resolveWorktree's store fallback. */
const makeCtx = (taskId: string) =>
  ({
    runId: taskId,
    workflowId: 'report',
    input: { taskId, kind: 'report' },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        batch: vi.fn().mockResolvedValue([]),
        atomic: vi.fn().mockResolvedValue(undefined),
      },
      traceStore: null,
    },
    currentStep: null,
    emit: vi.fn(),
    step: vi.fn(),
  }) as never

const worktreeOpts = (taskId: string) => ({
  worktree: { path: `/tmp/wt-${taskId}`, branch: `task/${taskId}` },
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Regression tests — report text durability (the "lost report" bug)
//
// A report run whose agent produces a final report MUST leave that report
// reachable through a normal Mars read (Arc.listProgress / `mars task show`)
// and not only inside the compressed transcript blob that is removed with
// the worktree.
//
// These tests FAIL on code that does not call Arc.appendProgress when
// reportText is provided, confirming the regression is caught.
// ---------------------------------------------------------------------------

describe('finalizeReport — report text durability', () => {
  it('calls Arc.appendProgress with kind=note when reportText is non-empty', async () => {
    const taskId = 'mars-report-rt-01'
    const reportText = '## Findings\n\nThe audit found three issues.\n'

    await finalizeReport(makeCtx(taskId), {
      ...worktreeOpts(taskId),
      reportText,
    })

    expect(mockAppendProgress).toHaveBeenCalledOnce()
    const [params] = mockAppendProgress.mock.calls[0]
    expect(params).toMatchObject({
      taskId,
      author: 'orchestrator',
      kind: 'note',
      body: reportText.trim(),
    })
  })

  it('trims whitespace from reportText before persisting', async () => {
    const taskId = 'mars-report-rt-02'
    const reportText = '  \n  findings here  \n  '

    await finalizeReport(makeCtx(taskId), {
      ...worktreeOpts(taskId),
      reportText,
    })

    expect(mockAppendProgress).toHaveBeenCalledOnce()
    const [params] = mockAppendProgress.mock.calls[0]
    expect(params.body).toBe('findings here')
  })

  it('does NOT call Arc.appendProgress when reportText is absent (legitimately empty audit)', async () => {
    const taskId = 'mars-report-rt-03'

    await finalizeReport(makeCtx(taskId), worktreeOpts(taskId))

    expect(mockAppendProgress).not.toHaveBeenCalled()
  })

  it('does NOT call Arc.appendProgress when reportText is blank whitespace', async () => {
    const taskId = 'mars-report-rt-04'

    await finalizeReport(makeCtx(taskId), {
      ...worktreeOpts(taskId),
      reportText: '   \n\t  ',
    })

    expect(mockAppendProgress).not.toHaveBeenCalled()
  })

  it('still marks the task done and removes the worktree even when reportText is provided', async () => {
    const taskId = 'mars-report-rt-05'

    const result = await finalizeReport(makeCtx(taskId), {
      ...worktreeOpts(taskId),
      reportText: 'My report',
    })

    expect(result).toEqual({ taskId, success: true, message: 'report complete' })

    const doneCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'done',
    )
    expect(doneCalls).toHaveLength(1)
    expect(mockRemoveWorktree).toHaveBeenCalledOnce()
  })
})

describe('finalizeReport — happy path', () => {
  it('returns { taskId, success: true, message: "report complete" }', async () => {
    const taskId = 'mars-report-01'

    const result = await finalizeReport(makeCtx(taskId), worktreeOpts(taskId))

    expect(result).toEqual({ taskId, success: true, message: 'report complete' })
  })

  it('calls updateTask with status=done and failedPhase=null', async () => {
    const taskId = 'mars-report-02'

    await finalizeReport(makeCtx(taskId), worktreeOpts(taskId))

    const doneCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'done',
    )
    expect(doneCalls).toHaveLength(1)
    expect(doneCalls[0][0]).toBe(taskId)
    expect(doneCalls[0][1]).toMatchObject({ status: 'done', failedPhase: null })
  })

  it('detaches branch and worktreePath before the done transition', async () => {
    // The done-implies-merged guard in updateTask reads the row's branch; the
    // branch was just deleted, so it must be NULL first or the report task is
    // redirected to failed/done-with-unverifiable-merge.
    const taskId = 'mars-report-02b'

    await finalizeReport(makeCtx(taskId), worktreeOpts(taskId))

    const patches = mockUpdateTask.mock.calls.map((c) => c[1] as Record<string, unknown>)
    const detachIdx = patches.findIndex((p) => p.branch === null && p.worktreePath === null)
    const doneIdx = patches.findIndex((p) => p.status === 'done')
    expect(detachIdx).toBeGreaterThanOrEqual(0)
    expect(detachIdx).toBeLessThan(doneIdx)
  })

  it('calls removeWorktree with the resolved worktree ref', async () => {
    const taskId = 'mars-report-03'

    await finalizeReport(makeCtx(taskId), worktreeOpts(taskId))

    expect(mockRemoveWorktree).toHaveBeenCalledOnce()
    const [ref] = mockRemoveWorktree.mock.calls[0]
    expect(ref).toMatchObject({ path: `/tmp/wt-${taskId}`, branch: `task/${taskId}` })
  })

  it('never calls mergeBranch or checkMergeTargetStatus', async () => {
    const taskId = 'mars-report-04'

    await finalizeReport(makeCtx(taskId), worktreeOpts(taskId))

    expect(mockMergeBranch).not.toHaveBeenCalled()
    expect(mockCheckMergeTargetStatus).not.toHaveBeenCalled()
  })

  it('never emits vcs-supervisor events', async () => {
    const taskId = 'mars-report-05'
    const ctx = makeCtx(taskId)

    await finalizeReport(ctx, worktreeOpts(taskId))

    const emitCalls = (ctx as { emit: ReturnType<typeof vi.fn> }).emit.mock.calls
    const vcsCalls = emitCalls.filter((c: unknown[]) => c[0] === 'vcs-supervisor-event')
    expect(vcsCalls).toHaveLength(0)
  })
})
