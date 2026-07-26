/**
 * Regression test — mars-42b5bfec
 *
 * Before the fix: a throwing `verifyChanges` left the task row in
 * `status='verifying'` until the phantom-task watchdog (30 min ceiling)
 * reaped it.  These tests assert the correct behaviour WITHOUT requiring
 * the watchdog to run at all.
 *
 * Coverage:
 *  1. `verifyChanges` throws → task transitions to `status='failed'` with
 *     `failedPhase='verify'` and `failureReasonCode='verify:step-threw'`.
 *  2. Normal verify failure (verifyChanges returns r.passed=false) → task
 *     is still set to `status='failed'` exactly once and the reason code is
 *     NOT 'verify:step-threw' (the existing deliberate-failure path is
 *     unchanged).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetContextCacheForTests } from '../../../core/context'

// ---------------------------------------------------------------------------
// Hoisted mocks — accessible in vi.mock factories AND in test bodies
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
  // acquireLock returns a release function
  mockAcquireLock: vi.fn().mockResolvedValue(() => undefined),
  // appendEnrichmentScopes returns its second arg unchanged
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

// Import the primitive AFTER vi.mock() calls are hoisted.
const { review } = await import('../index')

// ---------------------------------------------------------------------------
// Sandbox: point resolveContext at a temp dir so no test touches a real .mars
// ---------------------------------------------------------------------------

let tmpRepo: string

beforeAll(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'mars-verify-threw-'))
})

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

/** Minimal MarsCtx stub for testing the verify primitive. */
const makeCtx = (taskId = 'mars-test01') =>
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
    },
    currentStep: null,
    emit: vi.fn(),
    step: vi.fn(),
  }) as never

/** A worktree stub — the path need not exist for these tests. */
const worktree = (taskId: string) => ({
  path: `/tmp/wt-${taskId}`,
  branch: `task/${taskId}`,
})

// ---------------------------------------------------------------------------
// Shared beforeEach — reset all mocks to sane defaults
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
// Regression: throwing verifyChanges must not strand the task in 'verifying'
// ---------------------------------------------------------------------------

describe('verify — throwing verifyChanges transitions task to failed without the watchdog', () => {
  it('sets status=failed with failedPhase=verify and failureReasonCode=verify:step-threw', async () => {
    mockVerifyChanges.mockRejectedValue(new Error('ENOENT: lock file missing'))

    const taskId = 'mars-threw01'
    await expect(
      review(makeCtx(taskId), { kind: 'fix', worktree: worktree(taskId) }),
    ).rejects.toThrow('ENOENT: lock file missing')

    // Task must have been set to 'verifying' first — basic sanity check.
    const verifyingCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'verifying',
    )
    expect(verifyingCalls).toHaveLength(1)
    expect(verifyingCalls[0][0]).toBe(taskId)

    // Then immediately transitioned to 'failed' — no watchdog required.
    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0][0]).toBe(taskId)
    expect(failedCalls[0][1]).toMatchObject({
      status: 'failed',
      failedPhase: 'verify',
      failureReasonCode: 'verify:step-threw',
    })
    // The failure reason must embed the original error message.
    const failureReason = (failedCalls[0][1] as Record<string, unknown>)?.failureReason
    expect(typeof failureReason).toBe('string')
    expect(failureReason as string).toContain('ENOENT')
  })
})

// ---------------------------------------------------------------------------
// Guard: the normal verify-failure path (r.passed=false) is not disturbed
// ---------------------------------------------------------------------------

describe('verify — normal r.passed=false failure sets status=failed exactly once without verify:step-threw code', () => {
  it('uses the existing verifySignature code, not verify:step-threw', async () => {
    mockVerifyChanges.mockResolvedValue({
      passed: false,
      steps: [{ name: 'typecheck', passed: false, output: 'TS2345: type mismatch', tier: 'task' }],
    })

    const taskId = 'mars-threw02'
    await expect(
      review(makeCtx(taskId), { kind: 'fix', worktree: worktree(taskId) }),
    ).rejects.toThrow()

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    // Exactly one failed write — not double-counted by the new catch block.
    expect(failedCalls).toHaveLength(1)
    // The code must be the computed verify signature, not the generic step-threw code.
    const code = (failedCalls[0][1] as Record<string, unknown>)?.failureReasonCode
    expect(code).not.toBe('verify:step-threw')
  })
})

// ---------------------------------------------------------------------------
// Criterion 2: firstFailedOutput includes exit code + stderr excerpt
// ---------------------------------------------------------------------------

describe('verify — firstFailedOutput includes exit code and stderr when step has cmd metadata', () => {
  it('errorOutput passed to handleTaskFailureWithFixTask includes exitCode and stderr', async () => {
    mockVerifyChanges.mockResolvedValue({
      passed: false,
      steps: [
        {
          name: 'typecheck',
          passed: false,
          output: 'TS2345: type mismatch\nTS2554: error',
          tier: 'task' as const,
          cmd: 'npx',
          args: ['tsc', '--noEmit'],
          stepDir: '/tmp/wt-diag01',
          exitCode: 1,
          stdout: '',
          stderr: 'TS2345: type mismatch\nTS2554: error',
        },
      ],
    })

    const taskId = 'mars-diag01'
    await expect(
      review(makeCtx(taskId), { kind: 'fix', worktree: worktree(taskId) }),
    ).rejects.toThrow()

    expect(mockHandleTaskFailureWithFixTask).toHaveBeenCalledTimes(1)
    const failureInput = mockHandleTaskFailureWithFixTask.mock.calls[0][0] as Record<string, unknown>
    const errorOutput = failureInput.errorOutput as string
    // Must include the exit code so recovery prompts show the real gate context.
    expect(errorOutput).toContain('exitCode: 1')
    // Must include the stderr content.
    expect(errorOutput).toContain('TS2345: type mismatch')
  })
})

// ---------------------------------------------------------------------------
// Criterion 3: outer catch path populates capturedVerifyOutput and persists it
// ---------------------------------------------------------------------------

describe('verify — outer catch path sets verifyOutput on the updateTask call', () => {
  it('updateTask is called with verifyOutput containing the error when verifyChanges throws', async () => {
    mockVerifyChanges.mockRejectedValue(new Error('ENOENT: lock file missing'))

    const taskId = 'mars-diag02'
    await expect(
      review(makeCtx(taskId), { kind: 'fix', worktree: worktree(taskId) }),
    ).rejects.toThrow('ENOENT: lock file missing')

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    const payload = failedCalls[0][1] as Record<string, unknown>
    expect(payload.failureReasonCode).toBe('verify:step-threw')
    // The verifyOutput field must be a non-empty string containing the error.
    expect(typeof payload.verifyOutput).toBe('string')
    expect(payload.verifyOutput as string).toContain('verify:step-threw')
    expect(payload.verifyOutput as string).toContain('ENOENT: lock file missing')
  })
})
