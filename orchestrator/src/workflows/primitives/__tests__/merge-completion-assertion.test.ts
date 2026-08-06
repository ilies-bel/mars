/**
 * Tests for the post-merge ancestry assertion in the `merge()` primitive.
 *
 * Problem (this task): When `mergeBranch` returns `merged: true` but the ref
 * update silently failed or was a no-op, the merge primitive marked the task
 * done and deleted the branch — leaving commits unreachable. The related remerge
 * data-loss path saw branches silently recreated to the integration tip, so the
 * zero-commit short-circuit fired, removed the branch, and marked done while the
 * task's actual commits were never in integration.
 *
 * The fix adds a post-merge assertion: before `removeWorktree`, call
 * `isBranchTipInIntegration(mergePostSha, integrationBranch)`. If the assertion
 * fails, stamp the task `failed` and preserve the branch so the operator can
 * investigate.
 *
 * Coverage:
 *  1. Assertion passes (tip in integration) → worktree removed, task done.
 *  2. Assertion fails (tip NOT in integration) → task stamped failed, worktree
 *     NOT removed, branch preserved for investigation.
 *  3. When `mergePostSha` is absent (already-merged-noop path) → no assertion,
 *     normal completion.
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
  mockIsBranchTipInIntegration: vi.fn(),
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

  mockGetTask.mockResolvedValue(null)
  mockRemoveWorktree.mockResolvedValue(undefined)
  mockUpdateTask.mockResolvedValue(undefined)
  mockHandleTaskFailureWithFixTask.mockResolvedValue({ outcome: 'fix-task-spawned' })
  mockIsZeroCommitBranch.mockResolvedValue(false)
  mockCheckMergeTargetStatus.mockResolvedValue({ kind: 'clean' })
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
// Tests: post-merge ancestry assertion
// ---------------------------------------------------------------------------

describe('merge — post-merge ancestry assertion', () => {
  it('removes the worktree and marks done when branch tip is confirmed in integration', async () => {
    const taskId = 'mars-assert-pass-01'
    const mergePostSha = 'deadbeef1234abcd1234abcd1234abcd1234abcd'

    mockIsBranchTipInIntegration.mockResolvedValue(true)

    const enqueueFn = vi.fn().mockResolvedValue({
      status: 'done',
      result: makeMergeResult(mergePostSha),
    })

    await merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) })

    // Worktree must be removed
    expect(mockRemoveWorktree).toHaveBeenCalledOnce()

    // Task must be marked done
    const doneCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'done',
    )
    expect(doneCalls).toHaveLength(1)
    expect(doneCalls[0][0]).toBe(taskId)
  })

  it('fails and preserves the branch when tip is NOT an ancestor of integration', async () => {
    const taskId = 'mars-assert-fail-01'
    const mergePostSha = 'badf00d1111badf00d1111badf00d1111badf00d'

    // Assertion fails: branch tip not in integration
    mockIsBranchTipInIntegration.mockResolvedValue(false)

    const enqueueFn = vi.fn().mockResolvedValue({
      status: 'done',
      result: makeMergeResult(mergePostSha),
    })

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow(/post-merge-assertion/)

    // Branch must NOT be deleted (removeWorktree must not have been called)
    expect(mockRemoveWorktree).not.toHaveBeenCalled()

    // Task must be stamped failed (not done)
    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0][0]).toBe(taskId)
    expect((failedCalls[0][1] as Record<string, unknown>)?.failureReason).toBe(
      'merge:post-merge-assertion',
    )

    const doneCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'done',
    )
    expect(doneCalls).toHaveLength(0)
  })

  it('calls isBranchTipInIntegration with the merge SHA and integration branch', async () => {
    const taskId = 'mars-assert-args-01'
    const mergePostSha = 'cafecafe1111cafecafe1111cafecafe1111cafe'

    mockIsBranchTipInIntegration.mockResolvedValue(true)

    const enqueueFn = vi.fn().mockResolvedValue({
      status: 'done',
      result: makeMergeResult(mergePostSha),
    })

    await merge(makeCtx(taskId, enqueueFn), {
      kind: 'task',
      integrationBranch: 'main',
      ...worktreeOpts(taskId),
    })

    expect(mockIsBranchTipInIntegration).toHaveBeenCalledOnce()
    const [sha, intBranch] = mockIsBranchTipInIntegration.mock.calls[0]
    expect(sha).toBe(mergePostSha)
    expect(intBranch).toBe('main')
  })

  it('skips the assertion when mergePostSha is absent (already-merged-noop path)', async () => {
    const taskId = 'mars-assert-noop-01'

    // Result without mergePostSha (the already-merged-noop path)
    const enqueueFn = vi.fn().mockResolvedValue({
      status: 'done',
      result: makeMergeResult(), // no mergePostSha
    })

    // Assertion mock is NOT set up — if called, it would return undefined (falsy)
    mockIsBranchTipInIntegration.mockResolvedValue(true) // shouldn't be called

    await merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) })

    // Should succeed without calling the assertion (the noop path has no SHA to check)
    expect(mockIsBranchTipInIntegration).not.toHaveBeenCalled()

    const doneCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'done',
    )
    expect(doneCalls).toHaveLength(1)
  })
})
