/**
 * Regression test — mars-99d10de9
 *
 * Before the fix: when a verify child process died without the runner
 * receiving the exit event, the daemon heartbeat would stop heartbeating
 * after the grace window and wait for the phantom-task watchdog to detect
 * `runner-hung` — which could take another ~35 min. All 12 waiting verifies
 * starved.
 *
 * Fix: the heartbeat fires `verifyGateAbortController.abort('verify:child-vanished')`
 * after the grace window. The `verifyGateSignal` is passed to `verifyChanges`,
 * which kills any in-flight subprocess immediately and returns `passed: false`.
 * The `review` primitive detects the abort reason and:
 *   1. Marks the task `status='failed'` with `failureReasonCode='verify:child-vanished'`.
 *   2. Calls `releaseVerifySlot()` (via the finally block) so the semaphore
 *      slot is freed and the next queued verify can proceed.
 *
 * Coverage:
 *  1. verifyGateSignal pre-aborted with 'verify:child-vanished' →
 *     task set to failed with failureReasonCode='verify:child-vanished'.
 *  2. releaseVerifySlot() is called (slot freed) even on child-vanished abort.
 *  3. handleTaskFailureWithFixTask is NOT called (infrastructure event, not code defect).
 *  4. The abort is a no-op when verifyGateSignal fires with a different reason —
 *     the normal failure path is not disturbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetContextCacheForTests } from '../../../core/context'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockUpdateTask,
  mockVerifyChanges,
  mockLoadVerifyScopes,
  mockGetChangedFiles,
  mockAcquireLock,
  mockAppendEnrichmentScopes,
  mockRecordEnrichmentShadowRuns,
  mockHandleTaskFailureWithFixTask,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockVerifyChanges: vi.fn(),
  mockLoadVerifyScopes: vi.fn().mockResolvedValue([]),
  mockGetChangedFiles: vi.fn().mockResolvedValue([]),
  mockAcquireLock: vi.fn().mockResolvedValue(() => undefined),
  mockAppendEnrichmentScopes: vi.fn().mockImplementation(
    (_client: unknown, scopes: unknown[]) => Promise.resolve(scopes),
  ),
  mockRecordEnrichmentShadowRuns: vi.fn().mockResolvedValue(undefined),
  mockHandleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
}))

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return { ...orig, updateTask: mockUpdateTask }
})

vi.mock('../../../core/lib/git/verify', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/verify')>()
  return {
    ...orig,
    verifyChanges: mockVerifyChanges,
    loadVerifyScopes: mockLoadVerifyScopes,
    getChangedFiles: mockGetChangedFiles,
  }
})

vi.mock('../../../core/lib/gate-enrichment', () => ({
  appendEnrichmentScopes: mockAppendEnrichmentScopes,
  recordEnrichmentShadowRuns: mockRecordEnrichmentShadowRuns,
}))

vi.mock('../../../core/lib/git/lock', () => ({
  acquireLock: mockAcquireLock,
}))

vi.mock('../../../core/queue-fix-tasks', () => ({
  handleTaskFailureWithFixTask: mockHandleTaskFailureWithFixTask,
}))

vi.mock('../../../core/lib/git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/worktree')>()
  return {
    ...orig,
    restoreWorktreeIfMissing: vi.fn().mockResolvedValue('present'),
  }
})

const { review } = await import('../index')

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let tmpRepo: string

beforeAll(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'mars-verify-child-vanished-'))
})

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

const worktree = (taskId: string) => ({
  path: `/tmp/wt-${taskId}`,
  branch: `task/${taskId}`,
})

/**
 * Build a minimal MarsCtx with services wired for the child-vanished scenario.
 *
 * @param taskId  - unique task id for each test case
 * @param signal  - optional verifyGateSignal; defaults to a pre-aborted signal
 *                  with reason 'verify:child-vanished'
 * @param releaseSlot - spy to assert semaphore-slot release
 */
const makeCtx = (
  taskId: string,
  signal: AbortSignal | undefined,
  releaseSlot: () => void,
) =>
  ({
    runId: taskId,
    workflowId: 'task',
    input: { taskId, kind: 'fix' },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        batch: vi.fn().mockResolvedValue([]),
      },
      traceStore: null,
      acquireVerifySlot: vi.fn().mockResolvedValue(undefined),
      releaseVerifySlot: releaseSlot,
      verifyGateSignal: signal,
    },
    currentStep: null,
    emit: vi.fn(),
    step: vi.fn(),
  }) as never

// ---------------------------------------------------------------------------
// Shared reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env.MARS_REPO = tmpRepo
  __resetContextCacheForTests()

  mockUpdateTask.mockClear().mockResolvedValue(undefined)
  mockVerifyChanges.mockReset()
  mockLoadVerifyScopes.mockClear().mockResolvedValue([])
  mockGetChangedFiles.mockClear().mockResolvedValue([])
  mockAcquireLock.mockClear().mockResolvedValue(() => undefined)
  mockAppendEnrichmentScopes
    .mockClear()
    .mockImplementation((_c: unknown, sc: unknown[]) => Promise.resolve(sc))
  mockRecordEnrichmentShadowRuns.mockClear().mockResolvedValue(undefined)
  mockHandleTaskFailureWithFixTask.mockClear().mockResolvedValue({ outcome: 'fix-task-spawned' })
})

// ---------------------------------------------------------------------------
// Criterion 1 + 2 + 3: child-vanished abort → correct failure + slot release
// ---------------------------------------------------------------------------

describe('verify — child-vanished abort sets failureReasonCode and releases slot', () => {
  it('marks task failed with verify:child-vanished and calls releaseVerifySlot', async () => {
    // Simulate the abort that the heartbeat fires after the grace window.
    const ctrl = new AbortController()
    ctrl.abort('verify:child-vanished')

    const releaseSlot = vi.fn()

    // verifyChanges returns a failed result when the signal is already aborted:
    // the real implementation skips / kills each step and returns passed=false.
    mockVerifyChanges.mockResolvedValue({
      passed: false,
      verdict: 'FAIL',
      steps: [
        {
          name: 'spec-verify-cmd',
          passed: false,
          output: 'step not started: abort signal already fired',
          tier: 'task',
        },
      ],
    })

    const taskId = 'mars-cv01'
    await expect(
      review(makeCtx(taskId, ctrl.signal, releaseSlot), {
        kind: 'fix',
        worktree: worktree(taskId),
      }),
    ).rejects.toThrow('verify:child-vanished')

    // --- Criterion 1: correct failure recorded ---
    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0][0]).toBe(taskId)
    expect(failedCalls[0][1]).toMatchObject({
      status: 'failed',
      failedPhase: 'verify',
      failureReasonCode: 'verify:child-vanished',
      failureSignature: 'verify:child-vanished',
    })

    // --- Criterion 2: semaphore slot released ---
    expect(releaseSlot).toHaveBeenCalledTimes(1)

    // --- Criterion 3: no recovery fix task spawned ---
    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Criterion 4: a different abort reason does NOT trigger child-vanished path
// ---------------------------------------------------------------------------

describe('verify — unrelated abort reason falls through to normal failure path', () => {
  it('uses the generic verify signature, not verify:child-vanished', async () => {
    // Abort with an unrelated reason (e.g. an integration gate timeout).
    const ctrl = new AbortController()
    ctrl.abort('integration-gate-timeout')

    const releaseSlot = vi.fn()

    mockVerifyChanges.mockResolvedValue({
      passed: false,
      verdict: 'FAIL',
      steps: [
        {
          name: 'typecheck',
          passed: false,
          output: 'step killed by abort signal\nTS2345: error',
          tier: 'task',
          exitCode: null,
          cmd: 'npx',
          args: ['tsc', '--noEmit'],
          stepDir: `/tmp/wt-mars-cv02`,
        },
      ],
    })

    const taskId = 'mars-cv02'
    await expect(
      review(makeCtx(taskId, ctrl.signal, releaseSlot), {
        kind: 'fix',
        worktree: worktree(taskId),
      }),
    ).rejects.toThrow()

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    // Must NOT be classified as child-vanished (wrong abort reason).
    expect((failedCalls[0][1] as Record<string, unknown>)?.failureReasonCode).not.toBe(
      'verify:child-vanished',
    )
    // Slot still released.
    expect(releaseSlot).toHaveBeenCalledTimes(1)
  })
})
