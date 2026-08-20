/**
 * setup-worktree-rescue-operator.test.ts
 *
 * Verifies that `setupWorktree` drops a rescue-operator task with
 * `dropReason='origin-succeeded'` when its arc origin has already reached
 * status='done' by the time setup runs, and that the RescueOperator Worker
 * (via createWorktree) is never invoked.
 *
 * Observed incident 2026-08-18: rescue mars-68b1b5ac was dispatched after
 * its arc origin mars-291a4dc0 had already reached 'done'. There was no
 * valid RescueVerdict the worker could emit; the recovery had to land an
 * empty commit to exit cleanly. This guard prevents that scenario.
 *
 * Acceptance criteria:
 *   A. Origin done → rescue task dropped with dropReason='origin-succeeded',
 *      WorkflowTerminalError thrown, createWorktree not called.
 *   B. Origin still failing → setup proceeds normally, createWorktree called.
 *   C. Regular task (no rescue-operator tag) → guard is a no-op, setup proceeds.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetContextCacheForTests } from '../../../core/context'
import { WorkflowTerminalError } from '../../../core/lib/workflow-terminal-error'
import type { Task } from '../../../core/queue'

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before any top-level awaits)
// ---------------------------------------------------------------------------

const {
  mockUpdateTask,
  mockHasIncompleteBlockers,
  mockGetTask,
  mockCreateWorktree,
  mockSyncWorktreeToIntegration,
  mockInstallWorktreeDeps,
  mockRaiseActionQueueItem,
  mockRunTool,
  mockResolveOriginIdForTask,
  mockRestoreWorktreeIfMissing,
  mockProvisionCommitterWorktree,
  mockAttachToOriginWorktree,
  mockCaptureCheckpoint,
  mockDiscardWorkingTreeChanges,
  mockRestoreCheckpoint,
  mockCheckpointRefFor,
  mockFindLiveWorktreeDependents,
  mockRemoveWorktree,
  mockCheckIntegrationBranchDirty,
  mockParseMainCommiterPayload,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockHasIncompleteBlockers: vi.fn().mockResolvedValue(false),
  // Default: no task found — guard is a no-op.
  mockGetTask: vi.fn().mockResolvedValue(null),
  mockCreateWorktree: vi
    .fn()
    .mockResolvedValue({ path: '/tmp/fake-worktree', branch: 'task/rescue-01' }),
  mockSyncWorktreeToIntegration: vi.fn().mockResolvedValue({ kind: 'already-current' }),
  mockInstallWorktreeDeps: vi.fn().mockResolvedValue({ sites: [], totalDurationMs: 0 }),
  mockRaiseActionQueueItem: vi.fn().mockResolvedValue('aq-item-1'),
  mockRunTool: vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: 'abc1234\n',
    stderr: '',
    durationMs: 1,
    traceEventId: 'trace-1',
  }),
  mockResolveOriginIdForTask: vi.fn().mockImplementation(async (id: string) => id),
  mockRestoreWorktreeIfMissing: vi.fn().mockResolvedValue('present'),
  mockProvisionCommitterWorktree: vi
    .fn()
    .mockResolvedValue({ path: '/tmp/fake-committer', branch: 'task/fix-committer' }),
  mockAttachToOriginWorktree: vi
    .fn()
    .mockResolvedValue({ path: '/tmp/fake-origin', branch: 'task/origin' }),
  mockCaptureCheckpoint: vi.fn().mockResolvedValue({
    ref: 'refs/mars/checkpoint/test-task-preflight',
    sha: 'preflightsha1234',
    files: ['.mars/pg.dsn', '.mars/http.port'],
  }),
  mockDiscardWorkingTreeChanges: vi.fn().mockResolvedValue(undefined),
  mockRestoreCheckpoint: vi.fn().mockResolvedValue(undefined),
  mockCheckpointRefFor: vi.fn().mockImplementation(
    (key: string) => `refs/mars/checkpoint/${key.replace(/[^A-Za-z0-9._-]/g, '-')}`,
  ),
  mockFindLiveWorktreeDependents: vi.fn().mockResolvedValue([]),
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
  // Default: clean integration branch (guard passes through)
  mockCheckIntegrationBranchDirty: vi.fn().mockResolvedValue({ dirty: false, statusOutput: '' }),
  mockParseMainCommiterPayload: vi.fn().mockReturnValue(null),
}))

// ---------------------------------------------------------------------------
// vi.mock declarations (hoisted by Vitest before any module imports)
// ---------------------------------------------------------------------------

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return {
    ...orig,
    updateTask: mockUpdateTask,
    hasIncompleteBlockers: mockHasIncompleteBlockers,
    // Mock getTask so the origin-done check can be controlled per test.
    getTask: mockGetTask,
  }
})

vi.mock('../../../core/lib/main-dirty', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/main-dirty')>()
  return {
    ...orig,
    checkIntegrationBranchDirty: mockCheckIntegrationBranchDirty,
    parseMainCommiterPayload: mockParseMainCommiterPayload,
  }
})

vi.mock('../../../core/lib/git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/worktree')>()
  return {
    ...orig,
    createWorktree: mockCreateWorktree,
    syncWorktreeToIntegration: mockSyncWorktreeToIntegration,
    restoreWorktreeIfMissing: mockRestoreWorktreeIfMissing,
    provisionCommitterWorktree: mockProvisionCommitterWorktree,
    attachToOriginWorktree: mockAttachToOriginWorktree,
    removeWorktree: mockRemoveWorktree,
  }
})

vi.mock('../../../core/lib/worktree-install', () => ({
  installWorktreeDeps: mockInstallWorktreeDeps,
  repairInstallInPlace: vi.fn().mockResolvedValue({ repaired: false }),
  WorktreeInstallError: class WorktreeInstallError extends Error {},
  WorktreeModulesMissingError: class WorktreeModulesMissingError extends Error {
    failureStep = 'setup:modules-missing'
  },
}))

vi.mock('../../../core/lib/action-queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/action-queue')>()
  return { ...orig, raiseActionQueueItem: mockRaiseActionQueueItem }
})

vi.mock('../../../core/lib/run-tool', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/run-tool')>()
  return { ...orig, runTool: mockRunTool }
})

vi.mock('../../../core/lib/origin', () => ({
  resolveOriginIdForTask: mockResolveOriginIdForTask,
}))

vi.mock('../../../core/queue-fix-tasks', () => ({
  handleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
}))

vi.mock('../../../core/lib/git/checkpoint', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/checkpoint')>()
  return {
    ...orig,
    captureCheckpoint: mockCaptureCheckpoint,
    discardWorkingTreeChanges: mockDiscardWorkingTreeChanges,
    restoreCheckpoint: mockRestoreCheckpoint,
    checkpointRefFor: mockCheckpointRefFor,
  }
})

vi.mock('../../../core/lib/git/merge', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/merge')>()
  return {
    ...orig,
    isZeroCommitBranch: vi.fn().mockResolvedValue(false),
    checkMergeTargetStatus: vi.fn().mockResolvedValue({ kind: 'clean' }),
    isBranchTipInIntegration: vi.fn().mockResolvedValue(true),
  }
})

vi.mock('../../../core/lib/worktree-dependents', () => ({
  findLiveWorktreeDependents: mockFindLiveWorktreeDependents,
}))

vi.mock('../../../core/lib/run-worker-with-span', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/run-worker-with-span')>()
  return {
    ...orig,
    runNonLlmStepWithSpan: async <T>(opts: { fn: () => Promise<T> }) => opts.fn(),
  }
})

vi.mock('../../../core/lib/reflect-signals', () => ({
  recordSignals: vi.fn().mockResolvedValue(undefined),
}))

// Import the primitives AFTER all vi.mock() calls.
const { setupWorktree } = await import('../index')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESCUE_OPERATOR_TAG = 'rescue-operator'

let tmpRepo: string

/**
 * Build a minimal MarsCtx for setupWorktree.
 *
 * `storeGetTask` controls what `ctx.services.store.getTask(taskId)` returns.
 * The rescue-operator guard reads this to determine the task's tags and originId.
 */
function makeCtx(
  taskId: string,
  storeGetTask: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(null),
) {
  return {
    runId: taskId,
    workflowId: 'task',
    input: {
      taskId,
      kind: 'task',
      integrationBranch: 'main',
      recoveryPayload: null,
      fixForTaskId: null,
    },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store: {
        getTask: storeGetTask,
        query: vi.fn().mockResolvedValue({ rows: [] }),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        batch: vi.fn().mockResolvedValue([]),
        atomic: vi.fn().mockImplementation(async (fn: (scope: unknown) => Promise<void>) => {
          await fn({ execute: vi.fn().mockResolvedValue({ rows: [] }) })
        }),
      },
      traceStore: null,
    },
    currentStep: null,
    emit: vi.fn(),
    step: vi.fn(),
  } as never
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

beforeEach(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'mars-rescue-setup-'))
  process.env.MARS_REPO = tmpRepo
  __resetContextCacheForTests()

  // Reset all mocks to defaults.
  mockUpdateTask.mockReset().mockResolvedValue(undefined)
  mockHasIncompleteBlockers.mockReset().mockResolvedValue(false)
  mockGetTask.mockReset().mockResolvedValue(null)
  mockCreateWorktree.mockReset().mockResolvedValue({ path: '/tmp/fake-worktree', branch: 'task/rescue-01' })
  mockSyncWorktreeToIntegration.mockReset().mockResolvedValue({ kind: 'already-current' })
  mockInstallWorktreeDeps.mockReset().mockResolvedValue({ sites: [], totalDurationMs: 0 })
  mockRaiseActionQueueItem.mockReset().mockResolvedValue('aq-item-1')
  mockRunTool.mockReset().mockResolvedValue({
    exitCode: 0,
    stdout: 'abc1234\n',
    stderr: '',
    durationMs: 1,
    traceEventId: 'trace-1',
  })
  mockResolveOriginIdForTask.mockReset().mockImplementation(async (id: string) => id)
  mockRestoreWorktreeIfMissing.mockReset().mockResolvedValue('present')
  mockCaptureCheckpoint.mockReset().mockResolvedValue({
    ref: 'refs/mars/checkpoint/test-task-preflight',
    sha: 'preflightsha1234',
    files: ['.mars/pg.dsn', '.mars/http.port'],
  })
  mockDiscardWorkingTreeChanges.mockReset().mockResolvedValue(undefined)
  mockRestoreCheckpoint.mockReset().mockResolvedValue(undefined)
  mockCheckpointRefFor.mockReset().mockImplementation(
    (key: string) => `refs/mars/checkpoint/${key.replace(/[^A-Za-z0-9._-]/g, '-')}`,
  )
  mockFindLiveWorktreeDependents.mockReset().mockResolvedValue([])
  mockRemoveWorktree.mockReset().mockResolvedValue(undefined)
  mockCheckIntegrationBranchDirty.mockReset().mockResolvedValue({ dirty: false, statusOutput: '' })
  mockParseMainCommiterPayload.mockReset().mockReturnValue(null)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setupWorktree — rescue-operator origin-done guard', () => {
  // ── (A) Primary: origin already done → rescue dropped, Worker skipped ─────

  it(
    '(A) drops rescue-operator with origin-succeeded when arc origin is done',
    async () => {
      const rescueTaskId = 'rescue-aaa'
      const originId = 'origin-bbb'

      // store.getTask(rescueTaskId) returns the rescue task
      const storeGetTask = vi.fn().mockResolvedValue({
        id: rescueTaskId,
        tags: [RESCUE_OPERATOR_TAG],
        originId,
        status: 'running',
      } as unknown as Task)

      // getTask(originId, store) — the queue-level function — returns the done origin
      mockGetTask.mockResolvedValue({
        id: originId,
        status: 'done',
        tags: ['coder'],
        originId,
      } as unknown as Task)

      const ctx = makeCtx(rescueTaskId, storeGetTask)

      // Act: setupWorktree must throw WorkflowTerminalError
      await expect(setupWorktree(ctx)).rejects.toThrow(WorkflowTerminalError)

      // Assert: task dropped with origin-succeeded
      const droppedCall = mockUpdateTask.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>)?.status === 'dropped',
      )
      expect(droppedCall).toBeDefined()
      expect((droppedCall![1] as Record<string, unknown>).dropReason).toBe('origin-succeeded')

      // Assert: RescueOperator Worker never started — createWorktree not called
      expect(mockCreateWorktree).not.toHaveBeenCalled()
    },
  )

  it(
    '(A) thrown error has kind=origin-terminal',
    async () => {
      const rescueTaskId = 'rescue-ccc'
      const originId = 'origin-ddd'

      const storeGetTask = vi.fn().mockResolvedValue({
        id: rescueTaskId,
        tags: [RESCUE_OPERATOR_TAG],
        originId,
        status: 'running',
      } as unknown as Task)

      mockGetTask.mockResolvedValue({
        id: originId,
        status: 'done',
        tags: ['coder'],
        originId,
      } as unknown as Task)

      const ctx = makeCtx(rescueTaskId, storeGetTask)

      let caughtErr: unknown
      try {
        await setupWorktree(ctx)
      } catch (err) {
        caughtErr = err
      }

      expect(caughtErr).toBeInstanceOf(WorkflowTerminalError)
      expect((caughtErr as WorkflowTerminalError).kind).toBe('origin-terminal')
    },
  )

  // ── (B) Negative: origin still failing → setup proceeds normally ──────────

  it(
    '(B) does not drop rescue-operator when arc origin is still failing',
    async () => {
      const rescueTaskId = 'rescue-eee'
      const originId = 'origin-fff'

      const storeGetTask = vi.fn().mockResolvedValue({
        id: rescueTaskId,
        tags: [RESCUE_OPERATOR_TAG],
        originId,
        status: 'running',
      } as unknown as Task)

      // Origin is failed, not done
      mockGetTask.mockResolvedValue({
        id: originId,
        status: 'failed',
        tags: ['coder'],
        originId,
      } as unknown as Task)

      const ctx = makeCtx(rescueTaskId, storeGetTask)

      // Act: should NOT throw (origin is failed, not done)
      const result = await setupWorktree(ctx)

      // Assert: setup succeeded, createWorktree was called
      expect(result).toMatchObject({ path: '/tmp/fake-worktree' })
      expect(mockCreateWorktree).toHaveBeenCalledOnce()

      // Assert: task was NOT dropped
      const droppedCall = mockUpdateTask.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>)?.status === 'dropped',
      )
      expect(droppedCall).toBeUndefined()
    },
  )

  // ── (C) Negative: regular task → guard is a no-op ─────────────────────────

  it(
    '(C) does not affect regular tasks that lack the rescue-operator tag',
    async () => {
      const taskId = 'regular-ggg'

      // store.getTask returns a plain task (no rescue-operator tag)
      const storeGetTask = vi.fn().mockResolvedValue({
        id: taskId,
        tags: ['coder'],
        originId: taskId,
        status: 'running',
      } as unknown as Task)

      // getTask is never called for the origin (guard should short-circuit)
      mockGetTask.mockResolvedValue(null)

      const ctx = makeCtx(taskId, storeGetTask)

      // Act: should proceed normally
      const result = await setupWorktree(ctx)

      // Assert: createWorktree called (setup ran)
      expect(result).toMatchObject({ path: '/tmp/fake-worktree' })
      expect(mockCreateWorktree).toHaveBeenCalledOnce()

      // Assert: task not dropped
      const droppedCall = mockUpdateTask.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>)?.status === 'dropped',
      )
      expect(droppedCall).toBeUndefined()
    },
  )

  // ── (D) Edge: store.getTask returns null → guard skips safely ─────────────

  it(
    '(D) guard is a no-op when store.getTask returns null',
    async () => {
      const taskId = 'rescue-hhh'

      // store.getTask returns null (task not found — should not happen in prod,
      // but the guard must not crash)
      const storeGetTask = vi.fn().mockResolvedValue(null)

      const ctx = makeCtx(taskId, storeGetTask)

      // Act: should proceed normally (guard short-circuits on null selfTask)
      const result = await setupWorktree(ctx)

      expect(result).toMatchObject({ path: '/tmp/fake-worktree' })
      expect(mockCreateWorktree).toHaveBeenCalledOnce()
    },
  )

  // ── (E) Generalized: origin already re-queued/running (not done, not failed)
  //       → rescue dropped as a no-op WITHOUT running the full diagnosis agent.
  //
  //       Observed 2026-08-20: rescue mars-ed0e040e was dispatched a second
  //       time for arc mars-8693f3a4 after the arc had already been
  //       `continue`'d externally and was `status=running`. The old guard only
  //       checked for status='done', so the full diagnosis agent re-ran to
  //       reach the same 'continue' no-op verdict it had already reached.

  it(
    "(E) drops rescue-operator with dropReason='arc-rescued' when arc origin is running (already continued externally)",
    async () => {
      const rescueTaskId = 'rescue-iii'
      const originId = 'origin-jjj'

      const storeGetTask = vi.fn().mockResolvedValue({
        id: rescueTaskId,
        tags: [RESCUE_OPERATOR_TAG],
        originId,
        status: 'running',
      } as unknown as Task)

      // Origin was re-queued and is actively running again — no longer
      // 'failed', but also not 'done'.
      mockGetTask.mockResolvedValue({
        id: originId,
        status: 'running',
        tags: ['coder'],
        originId,
      } as unknown as Task)

      const ctx = makeCtx(rescueTaskId, storeGetTask)

      await expect(setupWorktree(ctx)).rejects.toThrow(WorkflowTerminalError)

      const droppedCall = mockUpdateTask.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>)?.status === 'dropped',
      )
      expect(droppedCall).toBeDefined()
      expect((droppedCall![1] as Record<string, unknown>).dropReason).toBe('arc-rescued')

      // The full RescueOperator diagnosis (which runs off the created
      // worktree) must never start.
      expect(mockCreateWorktree).not.toHaveBeenCalled()
    },
  )

  it(
    "(E) drops rescue-operator with dropReason='arc-rescued' when arc origin is queued (already restarted externally)",
    async () => {
      const rescueTaskId = 'rescue-kkk'
      const originId = 'origin-lll'

      const storeGetTask = vi.fn().mockResolvedValue({
        id: rescueTaskId,
        tags: [RESCUE_OPERATOR_TAG],
        originId,
        status: 'running',
      } as unknown as Task)

      mockGetTask.mockResolvedValue({
        id: originId,
        status: 'queued',
        tags: ['coder'],
        originId,
      } as unknown as Task)

      const ctx = makeCtx(rescueTaskId, storeGetTask)

      await expect(setupWorktree(ctx)).rejects.toThrow(WorkflowTerminalError)

      const droppedCall = mockUpdateTask.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>)?.status === 'dropped',
      )
      expect(droppedCall).toBeDefined()
      expect((droppedCall![1] as Record<string, unknown>).dropReason).toBe('arc-rescued')
      expect(mockCreateWorktree).not.toHaveBeenCalled()
    },
  )

  it(
    '(E) does not drop rescue-operator when arc origin is blocked (still eligible for rescue)',
    async () => {
      const rescueTaskId = 'rescue-mmm'
      const originId = 'origin-nnn'

      const storeGetTask = vi.fn().mockResolvedValue({
        id: rescueTaskId,
        tags: [RESCUE_OPERATOR_TAG],
        originId,
        status: 'running',
      } as unknown as Task)

      // 'blocked' stays alongside 'failed' as a status that does NOT
      // short-circuit the rescue — only a status that indicates the arc has
      // moved on (running, queued, done, dropped, ...) does.
      mockGetTask.mockResolvedValue({
        id: originId,
        status: 'blocked',
        tags: ['coder'],
        originId,
      } as unknown as Task)

      const ctx = makeCtx(rescueTaskId, storeGetTask)

      const result = await setupWorktree(ctx)

      expect(result).toMatchObject({ path: '/tmp/fake-worktree' })
      expect(mockCreateWorktree).toHaveBeenCalledOnce()

      const droppedCall = mockUpdateTask.mock.calls.find(
        (c) => (c[1] as Record<string, unknown>)?.status === 'dropped',
      )
      expect(droppedCall).toBeUndefined()
    },
  )
})
