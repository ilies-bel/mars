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
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockGetTask: vi.fn().mockResolvedValue(null),
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
  mockMergeBranch: vi.fn(),
  mockCheckMergeTargetStatus: vi.fn(),
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
