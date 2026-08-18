/**
 * Tests for the periodic merge-step heartbeat.
 *
 * The merge primitive starts a setInterval when the merge step begins and
 * clears it in a finally block so no tick fires after the step returns or
 * throws.  These tests verify both behaviours:
 *
 *  1. At least two 'merge-heartbeat' trace events are recorded while the
 *     merge worker is still in flight (slow merge simulation).
 *  2. No additional heartbeat events fire after the merge step settles.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
// Module mocks (identical to merge-watchdog-signature.test.ts)
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

const { merge } = await import('../../../workflows/primitives/index')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterAll(() => {
  delete process.env.MARS_REPO
  delete process.env.MARS_MERGE_HEARTBEAT_MS
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

afterEach(() => {
  vi.useRealTimers()
  delete process.env.MARS_MERGE_HEARTBEAT_MS
})

/** Minimal mock trace store that captures record() calls. */
const makeTraceStore = () => {
  const recorded: Array<{ kind: string; payload?: Record<string, unknown> }> = []
  const store = {
    record: vi.fn().mockImplementation((ev: { kind: string; payload?: Record<string, unknown> }) => {
      recorded.push(ev)
      return Promise.resolve()
    }),
    query: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  }
  return { store, recorded }
}

/** Minimal MarsCtx stub with a controllable enqueueFn and optional traceStore. */
const makeCtx = (
  taskId: string,
  enqueueFn: () => Promise<unknown>,
  traceStore: unknown = null,
) =>
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
      traceStore,
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

describe('merge step heartbeat', () => {
  it('fires at least two heartbeats while the merge worker is in flight and none after the step settles', async () => {
    // Use a 100 ms heartbeat so we can advance fake time cheaply.
    process.env.MARS_MERGE_HEARTBEAT_MS = '100'
    vi.useFakeTimers()

    const { store: traceStore, recorded } = makeTraceStore()

    // The enqueue function blocks indefinitely until failMerge() is called.
    let failMerge!: (e: Error) => void
    const slowEnqueue = vi.fn().mockImplementation(
      () => new Promise<never>((_, reject) => { failMerge = reject }),
    )

    const taskId = 'mars-hb-slow-01'
    const ctx = makeCtx(taskId, slowEnqueue, traceStore)

    const mergePromise = merge(ctx, { kind: 'task', ...worktreeOpts(taskId) })

    // Advance 250 ms of fake time: the interval fires at 100 ms and 200 ms.
    // vi.advanceTimersByTimeAsync flushes the microtask queue between timer
    // ticks, so the initial async setup (resolveTrace, updateTask, etc.)
    // completes before the first heartbeat fires.
    await vi.advanceTimersByTimeAsync(250)

    const heartbeatsWhileRunning = recorded.filter(e => e.kind === 'merge-heartbeat').length
    expect(heartbeatsWhileRunning).toBeGreaterThanOrEqual(2)

    // Fail the merge so the step settles and the finally block clears the interval.
    failMerge(new Error('heartbeat-test-cleanup'))
    await expect(mergePromise).rejects.toThrow()

    // After settlement: advance time significantly; the cleared interval must
    // not produce any additional heartbeat events.
    const countAtSettlement = recorded.filter(e => e.kind === 'merge-heartbeat').length
    await vi.advanceTimersByTimeAsync(500)
    const countAfterDelay = recorded.filter(e => e.kind === 'merge-heartbeat').length

    expect(countAfterDelay).toBe(countAtSettlement)
  })

  it('records subPhase and elapsedMs in each heartbeat payload', async () => {
    process.env.MARS_MERGE_HEARTBEAT_MS = '100'
    vi.useFakeTimers()

    const { store: traceStore, recorded } = makeTraceStore()

    let failMerge!: (e: Error) => void
    const slowEnqueue = vi.fn().mockImplementation(
      () => new Promise<never>((_, reject) => { failMerge = reject }),
    )

    const taskId = 'mars-hb-payload-01'
    const ctx = makeCtx(taskId, slowEnqueue, traceStore)
    const mergePromise = merge(ctx, { kind: 'task', ...worktreeOpts(taskId) })

    await vi.advanceTimersByTimeAsync(150)

    const heartbeat = recorded.find(e => e.kind === 'merge-heartbeat')
    expect(heartbeat).toBeDefined()
    expect(typeof (heartbeat?.payload as Record<string, unknown>)?.subPhase).toBe('string')
    expect(typeof (heartbeat?.payload as Record<string, unknown>)?.elapsedMs).toBe('number')

    failMerge(new Error('heartbeat-test-cleanup'))
    await expect(mergePromise).rejects.toThrow()
  })
})
