/**
 * Regression test for the race condition where recovery-exhaustion marks a task
 * `failed` (terminal) while the merge supervisor is still trying to advance it.
 *
 * Observed as: task mars-5d48eda6 failed with
 *   'Illegal task status transition: task is in terminal status failed and
 *    cannot transition to merging'  (recovery_exhausted:merge:crashed/unclassified)
 *
 * Root cause: the merge primitive's first action is
 *   updateTask(taskId, { status: 'merging' })
 * which throws `IllegalTransitionError` when the task is already in a terminal
 * state. The generic crash-handler then tries updateTask(failed), which ALSO
 * throws `IllegalTransitionError`, escaping the catch block as an unclassified
 * crash with a misleading signature.
 *
 * Fix: detect `IllegalTransitionError` before the generic crash-handler and
 * throw a `WorkflowTerminalError('merge-already-terminal', …)` so the dispatch
 * loop in server.ts can cleanly suppress the event without touching the DB.
 *
 * Coverage:
 *   1. `IllegalTransitionError` on the initial updateTask(merging) call →
 *      throws WorkflowTerminalError with kind 'merge-already-terminal'.
 *   2. No further updateTask call is made (no second crash-handler attempt).
 *   3. handleTaskFailureWithFixTask is not called (task is already settled).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetContextCacheForTests } from '../../../core/context'
import { IllegalTransitionError } from '../../../core/queue'
import { WorkflowTerminalError } from '../../../core/lib/workflow-terminal-error'

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
  mockUpdateTask: vi.fn(),
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

beforeEach(() => {
  process.env.MARS_REPO = '/tmp/test-repo'
  __resetContextCacheForTests()
  vi.clearAllMocks()

  // Default: updateTask succeeds
  mockUpdateTask.mockResolvedValue(undefined)
  mockGetTask.mockResolvedValue(null)
  mockIsZeroCommitBranch.mockResolvedValue(false)
  mockCheckMergeTargetStatus.mockResolvedValue({ kind: 'clean' })
  mockRemoveWorktree.mockResolvedValue(undefined)
  mockHandleTaskFailureWithFixTask.mockResolvedValue({ outcome: 'fix-task-spawned' })
  mockFindLiveWorktreeDependents.mockResolvedValue([])
})

/** Minimal MarsCtx stub. enqueueFn is not used in the race scenario
 * (updateTask throws before the merge queue call). */
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
      // Not called in this scenario (updateTask throws first).
      enqueueMergeJobAndAwait: vi.fn().mockResolvedValue({ status: 'done', result: { merged: true } }),
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

describe('merge — already-terminal race (recovery_exhausted race)', () => {
  it('throws WorkflowTerminalError(merge-already-terminal) when updateTask(merging) hits an IllegalTransitionError', async () => {
    const taskId = 'mars-already-terminal-01'

    // Simulate the race: the task is already 'failed' when the merge step
    // tries to set it to 'merging'. All subsequent updateTask calls succeed so
    // we can confirm the crash-handler never fires.
    mockUpdateTask.mockImplementation(
      (_id: string, patch: { status?: string }) => {
        if (patch.status === 'merging') {
          // The guard in updateTask throws because 'failed' is terminal.
          throw new IllegalTransitionError(taskId, 'failed', 'merging')
        }
        return Promise.resolve(undefined)
      },
    )

    let thrownError: unknown
    try {
      await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) })
    } catch (err) {
      thrownError = err
    }

    expect(thrownError).toBeInstanceOf(WorkflowTerminalError)
    const wte = thrownError as WorkflowTerminalError
    expect(wte.kind).toBe('merge-already-terminal')
    expect(wte.message).toContain(taskId)
    expect(wte.message).toContain('failed')
  })

  it('does NOT call updateTask with status=failed after the race (no crash-handler attempt)', async () => {
    const taskId = 'mars-already-terminal-02'

    mockUpdateTask.mockImplementation(
      (_id: string, patch: { status?: string }) => {
        if (patch.status === 'merging') {
          throw new IllegalTransitionError(taskId, 'failed', 'merging')
        }
        return Promise.resolve(undefined)
      },
    )

    await expect(
      merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    // Only the initial merging-transition call should have been made.
    // The crash-handler must NOT have fired another updateTask(failed) call.
    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(0)
  })

  it('does NOT spawn a fix-task after the race (task is already settled)', async () => {
    const taskId = 'mars-already-terminal-03'

    mockUpdateTask.mockImplementation(
      (_id: string, patch: { status?: string }) => {
        if (patch.status === 'merging') {
          throw new IllegalTransitionError(taskId, 'failed', 'merging')
        }
        return Promise.resolve(undefined)
      },
    )

    await expect(
      merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
  })
})
