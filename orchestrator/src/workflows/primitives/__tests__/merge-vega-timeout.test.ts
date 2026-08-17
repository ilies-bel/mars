/**
 * Tests for the vega-timeout failure path in the `merge()` primitive.
 *
 * When `invokeVcsSupervisor` is killed by the per-step wall-clock timeout it
 * returns `exitCode: 124`. `mergeBranch` detects this and sets
 * `vegaTimedOut: true` on the returned `MergeResult`. The merge primitive must
 * surface a distinct `merge:vega-timeout` failure signature rather than the
 * generic `merge:vcs-supervisor-aborted/unclassified` that the vega-abort path
 * previously produced.
 *
 * Regression guard for: task mars-16962472 — a hung vega-supervisor session
 * held the merge lock for 6m 36s with no progress events and no way for an
 * operator to distinguish "working" from "wedged".
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
  mockFindLiveWorktreeDependents,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockGetTask: vi.fn().mockResolvedValue(null),
  mockIsZeroCommitBranch: vi.fn().mockResolvedValue(false),
  mockCheckMergeTargetStatus: vi.fn().mockResolvedValue({ kind: 'clean' }),
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
  mockHandleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
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

const { merge } = await import('../index')

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

  mockUpdateTask.mockResolvedValue(undefined)
  mockGetTask.mockResolvedValue(null)
  mockIsZeroCommitBranch.mockResolvedValue(false)
  mockCheckMergeTargetStatus.mockResolvedValue({ kind: 'clean' })
  mockRemoveWorktree.mockResolvedValue(undefined)
  mockHandleTaskFailureWithFixTask.mockResolvedValue({ outcome: 'fix-task-spawned' })
  mockFindLiveWorktreeDependents.mockResolvedValue([])
})

/** Minimal MarsCtx stub with `enqueueMergeJobAndAwait` wired. */
const makeCtx = (taskId: string, enqueueFn: () => Promise<unknown>) =>
  ({
    runId: taskId,
    workflowId: 'task',
    input: { taskId, kind: 'task', integrationBranch: 'main' },
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
      enqueueMergeJobAndAwait: enqueueFn,
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

describe('merge — vega-timeout path', () => {
  it('sets failureReasonCode=merge:vega-timeout when mergeBranch returns vegaTimedOut', async () => {
    const taskId = 'mars-vega-timeout-01'
    const enqueueFn = vi.fn().mockResolvedValue({
      status: 'done',
      result: {
        merged: false,
        aborted: true,
        vegaTimedOut: true,
        conflictResolved: false,
        output: 'vcs-supervisor timed out after 600000ms; rebase aborted.',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      },
    })

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    // The task must be marked failed with the vega-timeout signature.
    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    const failPayload = failedCalls[0][1] as Record<string, unknown>
    expect(failPayload.failureReasonCode).toBe('merge:vega-timeout')
    expect(failPayload.failureSignature).toBe('merge:vega-timeout')
    expect(failPayload.failureReason).toBe('merge:vega-timeout')
    expect(failPayload.failedPhase).toBe('merge')
    expect(String(failPayload.error)).toContain('merge:vega-timeout')
  })

  it('calls handleTaskFailureWithFixTask with failingStep=merge:vega-timeout', async () => {
    const taskId = 'mars-vega-timeout-02'
    const enqueueFn = vi.fn().mockResolvedValue({
      status: 'done',
      result: {
        merged: false,
        aborted: true,
        vegaTimedOut: true,
        conflictResolved: false,
        output: 'vcs-supervisor timed out after 600000ms; rebase aborted.',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      },
    })

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    expect(mockHandleTaskFailureWithFixTask).toHaveBeenCalledWith(
      expect.objectContaining({ failingStep: 'merge:vega-timeout' }),
    )
  })

  it('does NOT set merge:vcs-supervisor-aborted when vegaTimedOut is true', async () => {
    const taskId = 'mars-vega-timeout-03'
    const enqueueFn = vi.fn().mockResolvedValue({
      status: 'done',
      result: {
        merged: false,
        aborted: true,
        vegaTimedOut: true,
        conflictResolved: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      },
    })

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    const failPayload = failedCalls[0][1] as Record<string, unknown>
    // Must NOT fall through to the generic vcs-supervisor-aborted path.
    expect(String(failPayload.failureReasonCode)).not.toContain('vcs-supervisor-aborted')
  })

  it('vega-timeout path does not affect the generic aborted path (vegaTimedOut=false)', async () => {
    const taskId = 'mars-vega-abort-generic'
    const enqueueFn = vi.fn().mockResolvedValue({
      status: 'done',
      result: {
        merged: false,
        aborted: true,
        vegaTimedOut: false,   // NOT a timeout
        conflictResolved: false,
        output: 'vcs-supervisor outcome rejected by git tree (stillInProgress=true, ...)',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      },
    })

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    const failPayload = failedCalls[0][1] as Record<string, unknown>
    // Generic abort path must still produce vcs-supervisor-aborted.
    expect(String(failPayload.failureReason)).toBe('merge:vcs-supervisor-aborted')
    expect(String(failPayload.failureReasonCode)).not.toBe('merge:vega-timeout')
  })
})
