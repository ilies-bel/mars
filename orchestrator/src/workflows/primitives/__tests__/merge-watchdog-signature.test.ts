/**
 * Tests for the watchdog-abort failure signature in the `merge()` primitive.
 *
 * Two distinct paths must produce diagnosable signatures rather than the
 * opaque `merge:crashed/unclassified`:
 *
 *  1. **instanceof path** — when a `MergeAbortedError` (reason='watchdog')
 *     escapes the step body and reaches the crash catch block directly, the
 *     primitive builds the signature from `err.lastStep` without going
 *     through `computeFailureSignature`.
 *     Example: `merge:crashed/watchdog-vega-supervisor`
 *
 *  2. **textual fallback** — when the error arrives as a plain string
 *     (e.g. after the merge-worker wraps MergeAbortedError into a
 *     MergeJobResult and the primitive re-throws it as `new Error(...)`),
 *     `computeFailureSignature` matches the "mergeBranch aborted (watchdog)
 *     ... during step" pattern and yields `merge:crashed/watchdog-timeout`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetContextCacheForTests } from '../../../core/context'
import { computeFailureSignature } from '../../../core/lib/failure-signature'

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
// Import SUT and MergeAbortedError after all vi.mock() hoisting
// ---------------------------------------------------------------------------

const { merge } = await import('../index')
const { MergeAbortedError } = await import('../../../core/lib/git/merge')

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
        // The merge primitive's idempotent-terminal short-circuit reads the task
        // row via `store.getTask` before doing any work. `null` = no terminal row,
        // so the merge proceeds and the generic watchdog-crash path is exercised.
        getTask: vi.fn().mockResolvedValue(null),
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

// Import the environmental-signature predicate (loaded after vi.mock() hoisting).
const { isEnvironmentalSignature } = await import('../../../core/lib/failure-kinds')

// ---------------------------------------------------------------------------
// Regression tests — worktree-vanished signature
// ---------------------------------------------------------------------------
//
// Regression for task mars-0c5ffe82: the stale-merging sweep deleted the task
// worktree while the merge job was still running. git spawned inside mergeBranch
// received ENOENT on its cwd; run-tool.ts emitted:
//   "runTool: spawn <tool> failed (working directory no longer exists: <path>)"
// The merge-worker wrapped it into a crash MergeJobResult; the merge primitive
// re-threw it and called computeFailureSignature('merge:crashed', ...). Without
// the worktree-vanished errorClassRule the error fell through to /unclassified,
// which consumed the arc's single recovery slot rather than auto-remerging.

describe('merge — worktree-vanished crash signature', () => {
  it('classifies "working directory no longer exists" as merge:crashed/worktree-vanished', () => {
    // Exact shape produced by run-tool.ts → merge-worker → merge primitive.
    const runToolError =
      'runTool: spawn /usr/bin/git failed (working directory no longer exists: /repo/.mars/worktrees/mars-0c5ffe82)'
    const crashMsg = `merge step crashed: merge job failed (crash): ${runToolError}`.slice(0, 1000)
    const sig = computeFailureSignature('merge:crashed', crashMsg)
    expect(sig).toBe('merge:crashed/worktree-vanished')
    expect(sig).not.toContain('unclassified')
  })

  it('merge:crashed/worktree-vanished is environmental (arc recovery budget is not consumed)', () => {
    // isEnvironmentalSignature drives the "don't spawn a fix-task" code path in
    // handleTaskFailureWithFixTask. If this returns false, the signature triggers
    // the normal recovery path and consumes the arc's single recovery slot.
    expect(isEnvironmentalSignature('merge:crashed/worktree-vanished')).toBe(true)
  })
})

describe('merge — watchdog crash signature', () => {
  it('produces merge:crashed/watchdog-<lastStep> via instanceof branch when MergeAbortedError is thrown directly (non-vega phase)', async () => {
    // Uses 'fast-forward' — a non-vega phase — so the vega-wedged branch is
    // NOT taken and the generic watchdog-crash path fires instead. Tests that
    // exercise vega-supervisor lastSteps live in merge-vega-wedged.test.ts.
    const taskId = 'mars-watchdog-01'
    const enqueueFn = vi.fn().mockRejectedValue(
      new MergeAbortedError('watchdog', 60_000, 'fast-forward'),
    )

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    expect((failedCalls[0][1] as Record<string, unknown>).failureSignature).toBe(
      'merge:crashed/watchdog-fast-forward',
    )
  })

  it('produces merge:crashed/watchdog-timeout via computeFailureSignature for the textual error path', () => {
    const errorMsg =
      "merge step crashed: mergeBranch aborted (watchdog) during step 'integration-gate'"
    expect(computeFailureSignature('merge:crashed', errorMsg)).toBe(
      'merge:crashed/watchdog-timeout',
    )
  })
})
