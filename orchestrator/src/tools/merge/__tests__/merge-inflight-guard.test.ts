/**
 * Tests for the real coder-process-liveness guard on `removeWorktree` inside
 * the `merge()` primitive (extends the mars-56b4584f incident fix).
 *
 * `findLiveWorktreeDependents` only sees OTHER task ROWS sharing the same
 * worktree/branch — it self-excludes `taskId`, so it cannot catch a
 * stale/duplicate dispatch of the SAME task id whose coder subprocess is
 * still alive while this run has reached the merge step. `ctx.services
 * .isImplementInFlight` (backed by the daemon's `TaskFlightTracker`) closes
 * that gap: the merge primitive checks it before every `removeWorktree` call
 * and defers removal when a coder process is still in flight for this task
 * id, exactly as it already defers for a live row dependent.
 *
 * Coverage:
 *  1. Success path (post-fast-forward removeWorktree): `isImplementInFlight`
 *     true → worktree preserved, task still marked done.
 *  2. Success path: `isImplementInFlight` false and no dependents → worktree
 *     removed as before (regression guard).
 *  3. `diagnose` kind: `isImplementInFlight` true → worktree preserved.
 *  4. Hook absent from `ctx.services` (falls back to `false`, same as before
 *     this guard existed) → worktree removed normally.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetContextCacheForTests } from '../../../core/context'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockUpdateTask,
  mockGetTask,
  mockIsZeroCommitBranch,
  mockCheckMergeTargetStatus,
  mockRemoveWorktree,
  mockHandleTaskFailureWithFixTask,
  mockIsBranchTipInIntegration,
  mockFindLiveWorktreeDependents,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockGetTask: vi.fn().mockResolvedValue(null),
  mockIsZeroCommitBranch: vi.fn().mockResolvedValue(false),
  mockCheckMergeTargetStatus: vi.fn().mockResolvedValue({ kind: 'clean' }),
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
  mockHandleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
  mockIsBranchTipInIntegration: vi.fn().mockResolvedValue(true),
  mockFindLiveWorktreeDependents: vi.fn().mockResolvedValue([]),
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return { ...orig, updateTask: mockUpdateTask, getTask: mockGetTask }
})

vi.mock('../../../core/lib/git/merge', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/merge')>()
  return {
    ...orig,
    isZeroCommitBranch: mockIsZeroCommitBranch,
    checkMergeTargetStatus: mockCheckMergeTargetStatus,
    isBranchTipInIntegration: mockIsBranchTipInIntegration,
  }
})

vi.mock('../../../core/lib/git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/worktree')>()
  return { ...orig, removeWorktree: mockRemoveWorktree }
})

vi.mock('../../../core/lib/worktree-dependents', () => ({
  findLiveWorktreeDependents: mockFindLiveWorktreeDependents,
}))

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
}))

vi.mock('../../../core/lib/run-worker-with-span', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/run-worker-with-span')>()
  return {
    ...orig,
    runNonLlmStepWithSpan: async <T>(opts: { fn: () => Promise<T> }) => opts.fn(),
  }
})

vi.mock('../../../core/queue-fix-tasks', () => ({
  handleTaskFailureWithFixTask: mockHandleTaskFailureWithFixTask,
}))

vi.mock('../../../core/lib/action-queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/action-queue')>()
  return { ...orig, raiseActionQueueItem: vi.fn().mockResolvedValue('aq-id') }
})

vi.mock('../../../core/lib/reflect-signals', () => ({
  recordSignals: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Import SUT after all vi.mock() hoisting
// ---------------------------------------------------------------------------

const { merge } = await import('../merge.js')

// ---------------------------------------------------------------------------
// Helpers
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
  mockHandleTaskFailureWithFixTask.mockResolvedValue({ outcome: 'fix-task-spawned' })
  mockIsZeroCommitBranch.mockResolvedValue(false)
  mockCheckMergeTargetStatus.mockResolvedValue({ kind: 'clean' })
  mockIsBranchTipInIntegration.mockResolvedValue(true)
  mockFindLiveWorktreeDependents.mockResolvedValue([])
})

/** Stub MergeResult for the success path. */
const makeMergeResult = (mergePostSha?: string) => ({
  merged: true,
  conflictResolved: false,
  aborted: false,
  output: '',
  supervisorConversation: [],
  vegaSessionId: null,
  retriesAttempted: 0,
  ...(mergePostSha !== undefined ? { mergePreSha: 'aaa000aaa', mergePostSha } : {}),
})

/**
 * Minimal MarsCtx stub with `enqueueMergeJobAndAwait` wired and, optionally,
 * a fake `isImplementInFlight` hook standing in for the daemon's real
 * `TaskFlightTracker`-backed implementation.
 */
const makeCtx = (
  taskId: string,
  enqueueFn: () => Promise<unknown>,
  isImplementInFlight?: (id: string) => boolean,
) =>
  ({
    runId: taskId,
    workflowId: 'task',
    input: { taskId, kind: 'task', integrationBranch: 'main' },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store: {
        getTask: vi.fn().mockResolvedValue(null),
        query: vi.fn().mockResolvedValue({ rows: [] }),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        batch: vi.fn().mockResolvedValue([]),
        atomic: vi.fn().mockResolvedValue(undefined),
      },
      traceStore: null,
      enqueueMergeJobAndAwait: enqueueFn,
      ...(isImplementInFlight !== undefined ? { isImplementInFlight } : {}),
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

describe('merge — real coder-process-liveness guard on removeWorktree', () => {
  it('preserves the worktree on the success path when a coder is still in flight for this task id', async () => {
    const taskId = 'mars-inflight-01'
    const mergePostSha = 'deadbeef1234abcd1234abcd1234abcd1234abcd'

    const enqueueFn = vi.fn().mockResolvedValue({
      status: 'done',
      result: makeMergeResult(mergePostSha),
    })

    // Fake TaskFlightTracker-backed hook: this exact task id is still coding.
    const isImplementInFlight = vi.fn((id: string) => id === taskId)

    const result = await merge(makeCtx(taskId, enqueueFn, isImplementInFlight), {
      kind: 'task',
      ...worktreeOpts(taskId),
    })

    expect(isImplementInFlight).toHaveBeenCalledWith(taskId)
    // Worktree must NOT be removed — a real coder process is still alive.
    expect(mockRemoveWorktree).not.toHaveBeenCalled()

    // The task is still marked done (the merge itself succeeded; only the
    // worktree reclamation is deferred).
    expect(result.success).toBe(true)
    const doneCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'done',
    )
    expect(doneCalls).toHaveLength(1)
    expect(doneCalls[0][0]).toBe(taskId)
  })

  it('removes the worktree on the success path when no coder is in flight and no dependents exist', async () => {
    const taskId = 'mars-inflight-02'
    const mergePostSha = 'cafecafe1111cafecafe1111cafecafe1111cafe'

    const enqueueFn = vi.fn().mockResolvedValue({
      status: 'done',
      result: makeMergeResult(mergePostSha),
    })

    const isImplementInFlight = vi.fn(() => false)

    await merge(makeCtx(taskId, enqueueFn, isImplementInFlight), {
      kind: 'task',
      ...worktreeOpts(taskId),
    })

    expect(isImplementInFlight).toHaveBeenCalledWith(taskId)
    expect(mockRemoveWorktree).toHaveBeenCalledOnce()
  })

  it('falls back to false (removes the worktree) when isImplementInFlight is absent from ctx.services', async () => {
    const taskId = 'mars-inflight-03'
    const mergePostSha = 'badf00d1111badf00d1111badf00d1111badf00d'

    const enqueueFn = vi.fn().mockResolvedValue({
      status: 'done',
      result: makeMergeResult(mergePostSha),
    })

    // No third argument — ctx.services.isImplementInFlight is undefined,
    // exactly like a scaffolded workflow or a test fixture predating this
    // guard.
    await merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) })

    expect(mockRemoveWorktree).toHaveBeenCalledOnce()
  })

  it('preserves the worktree on the diagnose path when a coder is still in flight for this task id', async () => {
    const taskId = 'mars-inflight-04'
    const enqueueFn = vi.fn()
    const isImplementInFlight = vi.fn((id: string) => id === taskId)

    const result = await merge(makeCtx(taskId, enqueueFn, isImplementInFlight), {
      kind: 'diagnose',
      ...worktreeOpts(taskId),
    })

    expect(mockRemoveWorktree).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    const doneCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'done',
    )
    expect(doneCalls).toHaveLength(1)
  })

  it('removes the worktree on the diagnose path when no coder is in flight', async () => {
    const taskId = 'mars-inflight-05'
    const enqueueFn = vi.fn()
    const isImplementInFlight = vi.fn(() => false)

    await merge(makeCtx(taskId, enqueueFn, isImplementInFlight), {
      kind: 'diagnose',
      ...worktreeOpts(taskId),
    })

    expect(mockRemoveWorktree).toHaveBeenCalledOnce()
  })
})
