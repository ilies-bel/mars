/**
 * Tests for the hard wall-clock timeout on the merge step (PRD bf7bbd39, slice 2).
 *
 * When `enqueueMergeJobAndAwait` never returns (because the merge worker is
 * wedged), the merge primitive races it against `MERGE_HARD_TIMEOUT_MS`. On
 * timeout:
 *   (a) the step rejects within `MERGE_HARD_TIMEOUT_MS + slack`,
 *   (b) the task is marked failed with failureSignature `merge:hard-timeout`,
 *   (c) the timing-out task does NOT unlink `.merge.lock` — the lock belongs
 *       to the running merge worker, not to this waiter.
 *
 * We set `MARS_MERGE_HARD_TIMEOUT_MS` to a short value (150 ms) before
 * importing so the timeout fires quickly without relying on fake timers.
 */

// Override the timeout BEFORE any module that reads it is imported.
process.env.MARS_MERGE_HARD_TIMEOUT_MS = '150'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockUpdateTask,
  mockGetTask,
  mockIsZeroCommitBranch,
  mockIsBranchTipInIntegration,
  mockCheckMergeTargetStatus,
  mockRemoveWorktree,
  mockHandleTaskFailureWithFixTask,
  mockFindLiveWorktreeDependents,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockGetTask: vi.fn().mockResolvedValue(null),
  mockIsZeroCommitBranch: vi.fn().mockResolvedValue(false),
  // Default: not yet merged (preserves existing test behaviour).
  mockIsBranchTipInIntegration: vi.fn().mockResolvedValue(false),
  mockCheckMergeTargetStatus: vi.fn().mockResolvedValue({ kind: 'clean' }),
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
  mockHandleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
  mockFindLiveWorktreeDependents: vi.fn().mockResolvedValue([]),
}))

// ---------------------------------------------------------------------------
// Module mocks — must be declared before top-level awaited imports
// ---------------------------------------------------------------------------

// The test state dir — shared constant so the context mock and the assertion
// both use the same path.
const TEST_STATE_DIR = '/tmp/mars-merge-hard-timeout-test'
const LOCK_PATH = join(TEST_STATE_DIR, '.merge.lock')

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return { ...orig, updateTask: mockUpdateTask, getTask: mockGetTask }
})

vi.mock('../../../core/lib/git/merge', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/merge')>()
  return {
    ...orig,
    isZeroCommitBranch: mockIsZeroCommitBranch,
    isBranchTipInIntegration: mockIsBranchTipInIntegration,
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
      stateDir: TEST_STATE_DIR,
      supervisorsManifest: [],
    }),
    getStateDir: () => TEST_STATE_DIR,
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
// Import SUT after all vi.mock() declarations
// ---------------------------------------------------------------------------

const { merge } = await import('../../../workflows/primitives/index')
const { __resetContextCacheForTests } = await import('../../../core/context')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterAll(() => {
  delete process.env.MARS_MERGE_HARD_TIMEOUT_MS
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

beforeEach(async () => {
  process.env.MARS_REPO = '/tmp/test-repo'
  __resetContextCacheForTests()
  vi.clearAllMocks()

  mockUpdateTask.mockResolvedValue(undefined)
  mockGetTask.mockResolvedValue(null)
  mockIsZeroCommitBranch.mockResolvedValue(false)
  mockIsBranchTipInIntegration.mockResolvedValue(false)
  mockCheckMergeTargetStatus.mockResolvedValue({ kind: 'clean' })
  mockRemoveWorktree.mockResolvedValue(undefined)
  mockHandleTaskFailureWithFixTask.mockResolvedValue({ outcome: 'fix-task-spawned' })
  mockFindLiveWorktreeDependents.mockResolvedValue([])

  // Ensure state dir exists for lock-file management.
  await mkdir(TEST_STATE_DIR, { recursive: true })
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

describe('merge — hard step-level timeout', () => {
  it(
    'rejects within MERGE_HARD_TIMEOUT_MS + slack when enqueueMergeJobAndAwait never resolves',
    async () => {
      const TIMEOUT_MS = 150 // matches process.env.MARS_MERGE_HARD_TIMEOUT_MS
      const SLACK_MS = 600 // generous slack to avoid flakiness on slow CI

      const taskId = 'mars-hard-timeout-01'

      // enqueueFn simulates the worker claiming the job (calls onClaimed so the
      // hard timer starts), writes the lock file (simulating mergeBranch holding
      // it), and then returns a promise that never resolves.
      const enqueueFn = vi.fn().mockImplementation(async (args: { onClaimed?: () => void }) => {
        args.onClaimed?.() // start the execution-only timer
        // Write the lock file so we can assert it is still present after the timeout.
        const { writeFileSync } = await import('node:fs')
        writeFileSync(LOCK_PATH, String(process.pid))
        // Never resolve — simulates a wedged merge worker.
        return new Promise<never>(() => {})
      })

      const ctx = makeCtx(taskId, enqueueFn)
      const start = Date.now()

      await expect(
        merge(ctx, { kind: 'task', ...worktreeOpts(taskId) }),
      ).rejects.toThrow()

      const elapsed = Date.now() - start
      // (a) Step rejects within MERGE_HARD_TIMEOUT_MS + slack.
      expect(elapsed).toBeLessThan(TIMEOUT_MS + SLACK_MS)

      // (b) Task marked failed with failureSignature 'merge:hard-timeout'.
      const failedCalls = mockUpdateTask.mock.calls.filter(
        (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
      )
      expect(failedCalls.length).toBeGreaterThanOrEqual(1)
      const hardTimeoutCall = failedCalls.find(
        (c) =>
          (c[1] as Record<string, unknown>)?.failureSignature === 'merge:hard-timeout',
      )
      expect(hardTimeoutCall).toBeDefined()

      // (c) Lock file is still present — the timing-out task must NOT unlink
      //     a mutex it never acquired. The lock belongs to the running merge
      //     worker's own finally block, not to this waiter.
      await expect(access(LOCK_PATH)).resolves.toBeUndefined()
    },
    // Generous test timeout — the step itself must exit within 150 + 600 ms,
    // but vitest also applies its own timeout ceiling.
    2000,
  )

  it('throws WorkflowTerminalError so the daemon suppresses a double DB write', async () => {
    const taskId = 'mars-hard-timeout-02'
    const { WorkflowTerminalError } = await import('../../../core/lib/workflow-terminal-error')

    const enqueueFn = vi.fn().mockImplementation(async (args: { onClaimed?: () => void }) => {
      args.onClaimed?.()
      return new Promise<never>(() => {})
    })

    const ctx = makeCtx(taskId, enqueueFn)
    await expect(
      merge(ctx, { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow(WorkflowTerminalError)
  }, 1000)

  it('hard-timeout error has failure kind merge-hard-timeout', async () => {
    const taskId = 'mars-hard-timeout-03'
    const { WorkflowTerminalError } = await import('../../../core/lib/workflow-terminal-error')

    const enqueueFn = vi.fn().mockImplementation(async (args: { onClaimed?: () => void }) => {
      args.onClaimed?.()
      return new Promise<never>(() => {})
    })

    const ctx = makeCtx(taskId, enqueueFn)
    let caughtError: unknown
    try {
      await merge(ctx, { kind: 'task', ...worktreeOpts(taskId) })
    } catch (err) {
      caughtError = err
    }

    expect(caughtError).toBeInstanceOf(WorkflowTerminalError)
    expect((caughtError as InstanceType<typeof WorkflowTerminalError>).kind).toBe(
      'merge-hard-timeout',
    )
  }, 1000)

  it(
    'a claimed task that times out does not unlink .merge.lock',
    async () => {
      // This is the ownership-safety test (the incident root cause, 2026-09-03).
      // The hard timer starts at CLAIM time — the moment the worker picks up
      // the job. When it fires, the task is executing inside mergeBranch but
      // has not yet acquired (or may have already released) the lock. The
      // primitive must never unlink a lock it does not own.

      const taskId = 'mars-hard-timeout-04'
      const { writeFileSync } = await import('node:fs')

      // Simulate a different (healthy) merge already holding the lock.
      writeFileSync(LOCK_PATH, 'other-task-pid')

      // enqueueFn calls onClaimed (simulating the worker picking up the job)
      // but never resolves — simulating a wedged execution that times out.
      const enqueueFn = vi.fn().mockImplementation((args: { onClaimed?: () => void }) => {
        args.onClaimed?.()
        return new Promise<never>(() => {})
      })

      const ctx = makeCtx(taskId, enqueueFn)

      await expect(
        merge(ctx, { kind: 'task', ...worktreeOpts(taskId) }),
      ).rejects.toThrow()

      // The lock file written by the other merge must still be present.
      // If merge.ts had blindly unlinked it, this would throw ENOENT.
      await expect(access(LOCK_PATH)).resolves.toBeUndefined()

      // Content must be unchanged — this task did not write to it.
      const { readFileSync } = await import('node:fs')
      expect(readFileSync(LOCK_PATH, 'utf8')).toBe('other-task-pid')
    },
    2000,
  )
})

// ---------------------------------------------------------------------------
// New tests: outcome check on hard timeout
// ---------------------------------------------------------------------------

describe('merge — hard-timeout: outcome check before failing', () => {
  it(
    'marks the task done when the branch is already an ancestor of the integration branch',
    async () => {
      const taskId = 'mars-hard-timeout-already-merged-01'

      // Merge job calls onClaimed (timer starts) but never resolves — simulates a slow/wedged worker.
      const enqueueFn = vi.fn().mockImplementation(async (args: { onClaimed?: () => void }) => {
        args.onClaimed?.()
        return new Promise<never>(() => {})
      })

      // Branch is already merged: the slow merge job completed in the background.
      mockIsBranchTipInIntegration.mockResolvedValue(true)

      const ctx = makeCtx(taskId, enqueueFn)

      // Should resolve successfully, not reject.
      const result = await merge(ctx, { kind: 'task', ...worktreeOpts(taskId) })

      expect(result.success).toBe(true)
      expect(result.taskId).toBe(taskId)

      // Task must be marked done.
      const doneCalls = mockUpdateTask.mock.calls.filter(
        (c) => (c[1] as Record<string, unknown>)?.status === 'done',
      )
      expect(doneCalls.length).toBeGreaterThanOrEqual(1)

      // Task must NOT be marked failed.
      const failedCalls = mockUpdateTask.mock.calls.filter(
        (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
      )
      expect(failedCalls.length).toBe(0)
    },
    1000,
  )

  it(
    'spawns no recovery task when the branch is already merged',
    async () => {
      const taskId = 'mars-hard-timeout-already-merged-02'

      const enqueueFn = vi.fn().mockImplementation(async (args: { onClaimed?: () => void }) => {
        args.onClaimed?.()
        return new Promise<never>(() => {})
      })

      mockIsBranchTipInIntegration.mockResolvedValue(true)

      const ctx = makeCtx(taskId, enqueueFn)
      await merge(ctx, { kind: 'task', ...worktreeOpts(taskId) })

      // No recovery/fix task must be spawned for a merge that succeeded.
      expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
    },
    1000,
  )

  it(
    'marks the task failed when the branch still has unmerged commits',
    async () => {
      const taskId = 'mars-hard-timeout-unmerged-01'

      const enqueueFn = vi.fn().mockImplementation(async (args: { onClaimed?: () => void }) => {
        args.onClaimed?.()
        return new Promise<never>(() => {})
      })

      // Branch NOT yet merged — the existing failure path must run.
      mockIsBranchTipInIntegration.mockResolvedValue(false)

      const ctx = makeCtx(taskId, enqueueFn)

      await expect(
        merge(ctx, { kind: 'task', ...worktreeOpts(taskId) }),
      ).rejects.toThrow()

      // Task stamped with the hard-timeout failure signature.
      const hardTimeoutCalls = mockUpdateTask.mock.calls.filter(
        (c) =>
          (c[1] as Record<string, unknown>)?.failureSignature === 'merge:hard-timeout',
      )
      expect(hardTimeoutCalls.length).toBeGreaterThanOrEqual(1)

      // Recovery task must be spawned.
      expect(mockHandleTaskFailureWithFixTask).toHaveBeenCalled()
    },
    1000,
  )
})

// ---------------------------------------------------------------------------
// Tests: outer watchdog (enqueueMergeJobAndAwait returns { status:'failed',
// errorCode:'watchdog' }) — same reachability check as the step-level timeout.
// ---------------------------------------------------------------------------

describe('merge — outer watchdog: outcome check before failing', () => {
  it(
    'marks the task done when the outer watchdog fires after a successful fast-forward',
    async () => {
      const taskId = 'mars-outer-watchdog-already-merged-01'

      // Outer watchdog: enqueueMergeJobAndAwait resolves with a watchdog failure
      // immediately (no onClaimed call, so the step-level timer never fires).
      const enqueueFn = vi.fn().mockResolvedValue({
        status: 'failed',
        error: `merge:timeout — merge job for task ${taskId} was not resolved within 45 min`,
        errorCode: 'watchdog',
      })

      // The branch tip is already on the integration branch — fast-forward landed.
      mockIsBranchTipInIntegration.mockResolvedValue(true)

      const ctx = makeCtx(taskId, enqueueFn)
      const result = await merge(ctx, { kind: 'task', ...worktreeOpts(taskId) })

      expect(result.success).toBe(true)
      expect(result.taskId).toBe(taskId)
      expect(result.message).toContain('outer-watchdog')

      // Task marked done, not failed.
      const doneCalls = mockUpdateTask.mock.calls.filter(
        (c) => (c[1] as Record<string, unknown>)?.status === 'done',
      )
      expect(doneCalls.length).toBeGreaterThanOrEqual(1)
      const failedCalls = mockUpdateTask.mock.calls.filter(
        (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
      )
      expect(failedCalls.length).toBe(0)

      // No recovery task spawned — the merge succeeded.
      expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
    },
  )

  it(
    'marks the task failed when the outer watchdog fires and the merge is genuinely stuck',
    async () => {
      const taskId = 'mars-outer-watchdog-unmerged-01'

      const enqueueFn = vi.fn().mockResolvedValue({
        status: 'failed',
        error: `merge:timeout — merge job for task ${taskId} was not resolved within 45 min`,
        errorCode: 'watchdog',
      })

      // Branch NOT yet merged.
      mockIsBranchTipInIntegration.mockResolvedValue(false)

      const ctx = makeCtx(taskId, enqueueFn)

      await expect(
        merge(ctx, { kind: 'task', ...worktreeOpts(taskId) }),
      ).rejects.toThrow()

      // Task stamped failed (via the generic crash handler).
      const failedCalls = mockUpdateTask.mock.calls.filter(
        (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
      )
      expect(failedCalls.length).toBeGreaterThanOrEqual(1)
    },
  )
})
