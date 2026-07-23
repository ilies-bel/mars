/**
 * Tests for the zero-commit branch short-circuit in the `merge()` primitive.
 *
 * Problem (this task): A recovery task that legitimately produces no commits
 * used to run the full merge machinery — including acquiring the serialised
 * `.merge.lock` — for a complete no-op.  The fix calls `isZeroCommitBranch`
 * before `checkMergeTargetStatus` and, when the branch has zero commits ahead
 * of the integration branch, removes the worktree, marks the task done, and
 * returns a successful MergeOutput without ever touching the merge lock.
 *
 * Coverage:
 *   1. Zero-commit branch → merge returns success, worktree removed, task done,
 *      neither mergeBranch nor checkMergeTargetStatus is called.
 *   2. Non-zero-commit branch → isZeroCommitBranch=false falls through to the
 *      normal merge path (checkMergeTargetStatus is called).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetContextCacheForTests } from '../../../core/context'

// ---------------------------------------------------------------------------
// Hoisted mocks — accessible inside vi.mock() factories AND in test bodies.
// ---------------------------------------------------------------------------

const {
  mockUpdateTask,
  mockGetTask,
  mockIsZeroCommitBranch,
  mockMergeBranch,
  mockCheckMergeTargetStatus,
  mockRemoveWorktree,
  mockHandleTaskFailureWithFixTask,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockGetTask: vi.fn().mockResolvedValue(null),
  mockIsZeroCommitBranch: vi.fn(),
  mockMergeBranch: vi.fn(),
  mockCheckMergeTargetStatus: vi.fn(),
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
  mockHandleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
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
    mergeBranch: mockMergeBranch,
    checkMergeTargetStatus: mockCheckMergeTargetStatus,
  }
})

vi.mock('../../../core/lib/git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/worktree')>()
  return { ...orig, removeWorktree: mockRemoveWorktree }
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

// Strip the span wrapper so merge() runs the inner fn() directly.
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

// action-queue raise is called in some error paths — stub to avoid real I/O.
vi.mock('../../../core/lib/action-queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/action-queue')>()
  return { ...orig, raiseActionQueueItem: vi.fn().mockResolvedValue('aq-id') }
})

// ---------------------------------------------------------------------------
// Import module under test AFTER vi.mock() hoisting is complete.
// ---------------------------------------------------------------------------

const { merge } = await import('../index')

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
  // Default: getTask returns null → preview gate is skipped.
  mockGetTask.mockResolvedValue(null)
  mockRemoveWorktree.mockResolvedValue(undefined)
  mockUpdateTask.mockResolvedValue(undefined)
  mockHandleTaskFailureWithFixTask.mockResolvedValue({ outcome: 'fix-task-spawned' })
})

/** Minimal MarsCtx stub. Pass `opts.worktree` to bypass resolveWorktree's store fallback. */
const makeCtx = (taskId: string) =>
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

describe('merge — zero-commit branch short-circuit', () => {
  it('returns success without acquiring merge lock when branch has zero commits ahead', async () => {
    const taskId = 'mars-zero-merge-01'
    mockIsZeroCommitBranch.mockResolvedValue(true)

    const result = await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) })

    expect(result).toEqual({
      taskId,
      success: true,
      message: 'zero-commit branch — no merge needed',
    })
  })

  it('marks the task done when branch has zero commits ahead', async () => {
    const taskId = 'mars-zero-merge-02'
    mockIsZeroCommitBranch.mockResolvedValue(true)

    await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) })

    const doneCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'done',
    )
    expect(doneCalls).toHaveLength(1)
    expect(doneCalls[0][0]).toBe(taskId)
  })

  it('removes the worktree when branch has zero commits ahead', async () => {
    const taskId = 'mars-zero-merge-03'
    mockIsZeroCommitBranch.mockResolvedValue(true)

    await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) })

    expect(mockRemoveWorktree).toHaveBeenCalledOnce()
    const [ref] = mockRemoveWorktree.mock.calls[0]
    expect(ref).toMatchObject({ path: `/tmp/wt-${taskId}`, branch: `task/${taskId}` })
  })

  it('does not call mergeBranch or checkMergeTargetStatus when branch has zero commits ahead', async () => {
    const taskId = 'mars-zero-merge-04'
    mockIsZeroCommitBranch.mockResolvedValue(true)

    await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) })

    expect(mockMergeBranch).not.toHaveBeenCalled()
    expect(mockCheckMergeTargetStatus).not.toHaveBeenCalled()
  })

  it('calls isZeroCommitBranch with the task branch and repo root', async () => {
    const taskId = 'mars-zero-merge-05'
    mockIsZeroCommitBranch.mockResolvedValue(true)

    await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) })

    expect(mockIsZeroCommitBranch).toHaveBeenCalledOnce()
    const [branch, repoRoot] = mockIsZeroCommitBranch.mock.calls[0]
    expect(branch).toBe(`task/${taskId}`)
    expect(repoRoot).toBe('/tmp/test-repo')
  })
})

describe('merge — non-zero-commit branch falls through to normal path', () => {
  it('calls checkMergeTargetStatus when branch has commits ahead', async () => {
    const taskId = 'mars-nonzero-merge-01'
    mockIsZeroCommitBranch.mockResolvedValue(false)
    // Simulate a successful preflight so the test doesn't throw unexpectedly.
    mockCheckMergeTargetStatus.mockResolvedValue({ kind: 'ok' })
    // mergeBranch would be called next — let it throw a recognisable error so
    // we can confirm the flow reached that point without needing a real repo.
    mockMergeBranch.mockRejectedValue(new Error('merge-reached'))

    await expect(
      merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    expect(mockCheckMergeTargetStatus).toHaveBeenCalledOnce()
  })
})
