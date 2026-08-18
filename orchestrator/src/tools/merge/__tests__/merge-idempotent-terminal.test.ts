/**
 * Tests for the idempotent terminal short-circuit in `merge()`.
 *
 * When a task's row already reads `done`, `failed`, or `dropped` at the top of
 * merge(), the primitive must return immediately without acquiring the merge
 * lock or invoking the merge worker (`enqueueMergeJobAndAwait`).
 *
 * Coverage:
 *  1. status='done'   → success:true,  message contains 'already terminal'
 *  2. status='failed' → success:false, message contains 'already failed'
 *
 * In both cases:
 *  - enqueueMergeJobAndAwait is never called (⇒ mergeBranch never runs)
 *  - no merge lock is acquired (the lock is created inside the merge worker,
 *    which is gated by enqueueMergeJobAndAwait — so asserting that fn was not
 *    called is sufficient to prove no lock is touched)
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

const { merge } = await import('../../../workflows/primitives/index.js')

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
  mockIsBranchTipInIntegration.mockResolvedValue(true)
})

/**
 * Build a minimal MarsCtx stub. enqueueFn is the spy we assert was (not)
 * called; storeGetTask determines which task row the short-circuit reads.
 */
const makeCtx = (
  taskId: string,
  enqueueFn: ReturnType<typeof vi.fn>,
  storeGetTask: ReturnType<typeof vi.fn>,
) =>
  ({
    runId: taskId,
    workflowId: 'task',
    input: { taskId, kind: 'task', integrationBranch: 'main' },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store: {
        getTask: storeGetTask,
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

describe('merge — idempotent terminal short-circuit', () => {
  it('returns success:true with "already terminal" when task is already done, without calling enqueueMergeJobAndAwait', async () => {
    const taskId = 'mars-idempotent-done-01'
    const enqueueFn = vi.fn()
    const storeGetTask = vi.fn().mockResolvedValue({ id: taskId, status: 'done' })

    const result = await merge(makeCtx(taskId, enqueueFn, storeGetTask), {
      kind: 'task',
      ...worktreeOpts(taskId),
    })

    // (a) mergeBranch was never invoked — proxied through enqueueMergeJobAndAwait
    expect(enqueueFn).not.toHaveBeenCalled()

    // (b) merge lock was never created — corollary: enqueueMergeJobAndAwait not called
    // (the lock lives inside the merge worker, which is only reached via enqueueFn)

    // (c) returned MergeOutput has success:true and message contains 'already terminal'
    expect(result.success).toBe(true)
    expect(result.message).toContain('already terminal')
    expect(result.taskId).toBe(taskId)
  })

  it('returns success:false with "already failed" when task is already failed, without calling enqueueMergeJobAndAwait', async () => {
    const taskId = 'mars-idempotent-failed-01'
    const enqueueFn = vi.fn()
    const storeGetTask = vi.fn().mockResolvedValue({ id: taskId, status: 'failed' })

    const result = await merge(makeCtx(taskId, enqueueFn, storeGetTask), {
      kind: 'task',
      ...worktreeOpts(taskId),
    })

    // (a) mergeBranch was never invoked
    expect(enqueueFn).not.toHaveBeenCalled()

    // (c) returned MergeOutput has success:false and message contains 'already failed'
    expect(result.success).toBe(false)
    expect(result.message).toContain('already failed')
    expect(result.taskId).toBe(taskId)
  })
})
