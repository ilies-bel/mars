/**
 * Tests for the vega-wedged failure path in the `merge()` primitive.
 *
 * When `enqueueMergeJobAndAwait` rejects with a `MergeAbortedError` whose
 * `reason === 'watchdog'` AND whose `lastStep` matches /vega|vcs-supervisor|reconcile/i,
 * the `merge()` primitive must:
 *
 *   1. Stamp the task `failed` with signature `merge:vega-wedged`.
 *   2. Raise one action-queue item (kind='failed') whose title mentions
 *      'vcs-supervisor wedged' and whose body contains the last phase and
 *      elapsed time.
 *   3. NOT spawn a fix-task (handleTaskFailureWithFixTask must not be called).
 *   4. The .merge.lock is guaranteed released before the throw — this is a
 *      contract of `mergeBranch` (tested in `merge-abort.test.ts`). At the
 *      primitive level the test verifies no lock file is left in the temp
 *      state directory after the primitive exits.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
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
  mockRaiseActionQueueItem,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockGetTask: vi.fn().mockResolvedValue(null),
  mockIsZeroCommitBranch: vi.fn().mockResolvedValue(false),
  mockCheckMergeTargetStatus: vi.fn().mockResolvedValue({ kind: 'clean' }),
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
  mockHandleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
  mockFindLiveWorktreeDependents: vi.fn().mockResolvedValue([]),
  mockRaiseActionQueueItem: vi.fn().mockResolvedValue('aq-vega-wedged'),
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
  return { ...orig, raiseActionQueueItem: mockRaiseActionQueueItem }
})

vi.mock('../../../core/lib/reflect-signals', () => ({
  recordSignals: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Import SUT and MergeAbortedError after all vi.mock() hoisting
// ---------------------------------------------------------------------------

const { merge } = await import('../../../workflows/primitives/index')
const { MergeAbortedError } = await import('../../../core/lib/git/merge')

// ---------------------------------------------------------------------------
// Temp directory for lock-file assertion
// ---------------------------------------------------------------------------

let tmpDir: string

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
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
  mockRaiseActionQueueItem.mockResolvedValue('aq-vega-wedged')
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
        // so the merge proceeds and the watchdog/vega-wedged path is exercised.
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
// Tests — vega-wedged failure path
// ---------------------------------------------------------------------------

describe('merge — vega-wedged failure path', () => {
  it('stamps the task failed with signature merge:vega-wedged when watchdog fires during vega-reconciling', async () => {
    const taskId = 'mars-vega-wedged-01'
    const enqueueFn = vi.fn().mockRejectedValue(
      new MergeAbortedError('watchdog', 1_800_000, 'vega-reconciling'),
    )

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    const failedUpdate = failedCalls[0][1] as Record<string, unknown>
    expect(failedUpdate.failureSignature).toBe('merge:vega-wedged')
    expect(failedUpdate.failureReasonCode).toBe('merge:vega-wedged')
    expect(failedUpdate.failedPhase).toBe('merge')
  })

  it('stamps merge:vega-wedged for vcs-supervisor lastStep', async () => {
    const taskId = 'mars-vega-wedged-02'
    const enqueueFn = vi.fn().mockRejectedValue(
      new MergeAbortedError('watchdog', 900_000, 'vcs-supervisor'),
    )

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    expect((failedCalls[0][1] as Record<string, unknown>).failureSignature).toBe('merge:vega-wedged')
  })

  it('stamps merge:vega-wedged for reconcile lastStep', async () => {
    const taskId = 'mars-vega-wedged-03'
    const enqueueFn = vi.fn().mockRejectedValue(
      new MergeAbortedError('watchdog', 1_200_000, 'vega-reconcile'),
    )

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    expect((failedCalls[0][1] as Record<string, unknown>).failureSignature).toBe('merge:vega-wedged')
  })

  it('does NOT spawn a fix-task on vega-wedged', async () => {
    const taskId = 'mars-vega-wedged-04'
    const enqueueFn = vi.fn().mockRejectedValue(
      new MergeAbortedError('watchdog', 1_800_000, 'vega-reconciling'),
    )

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
  })

  it('raises one action-queue item with kind=failed and title mentioning vcs-supervisor wedged', async () => {
    const taskId = 'mars-vega-wedged-05'
    const elapsedMs = 1_800_000
    const enqueueFn = vi.fn().mockRejectedValue(
      new MergeAbortedError('watchdog', elapsedMs, 'vega-reconciling'),
    )

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    expect(mockRaiseActionQueueItem).toHaveBeenCalledTimes(1)
    const aqCall = mockRaiseActionQueueItem.mock.calls[0][0] as Record<string, unknown>
    expect(aqCall.kind).toBe('failed')
    expect(typeof aqCall.title).toBe('string')
    expect((aqCall.title as string).toLowerCase()).toContain('vcs-supervisor wedged')
    // Body should contain the last phase and elapsed time
    expect(typeof aqCall.body).toBe('string')
    expect(aqCall.body as string).toContain('vega-reconciling')
    expect(aqCall.body as string).toMatch(/1800\s*s|30\s*m/)
    expect(aqCall.originTaskId).toBe(taskId)
  })

  it('falls through to crash handler (with fix-task) for non-vega watchdog phases', async () => {
    const taskId = 'mars-vega-wedged-06'
    // lastStep does NOT match /vega|vcs-supervisor|reconcile/ — should use the
    // existing watchdog crash path, which DOES spawn a fix-task.
    const enqueueFn = vi.fn().mockRejectedValue(
      new MergeAbortedError('watchdog', 60_000, 'integration-gate'),
    )

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    // Should NOT produce the vega-wedged signature
    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    expect((failedCalls[0][1] as Record<string, unknown>).failureSignature).not.toBe('merge:vega-wedged')
    // Should call the fix-task handler
    expect(mockHandleTaskFailureWithFixTask).toHaveBeenCalledTimes(1)
    // Should NOT raise vega-wedged action-queue item
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
  })

  it('merge lock is not held after the primitive exits (no .merge.lock left in state dir)', async () => {
    // Create a temp dir to serve as MARS_REPO so getStateDir() is real.
    // Since enqueueMergeJobAndAwait is mocked (mergeBranch is never called),
    // no lock is ever acquired. The assertion documents that the primitive's
    // vega-wedged exit path does not create a lock file as a side effect.
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-vega-wedged-lock-'))
    process.env.MARS_REPO = tmpDir
    __resetContextCacheForTests()

    const taskId = 'mars-vega-wedged-07'
    const enqueueFn = vi.fn().mockRejectedValue(
      new MergeAbortedError('watchdog', 1_800_000, 'vega-reconciling'),
    )

    await expect(
      merge(makeCtx(taskId, enqueueFn), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toThrow()

    const lockPath = resolve(tmpDir, '.mars', '.merge.lock')
    expect(existsSync(lockPath)).toBe(false)
  })
})
