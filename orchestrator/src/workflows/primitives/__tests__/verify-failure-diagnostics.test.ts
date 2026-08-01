/**
 * Regression tests — mars-259d2854
 *
 * Two cases lock in the diagnostics-capture behaviour for verify failures so
 * neither path can silently regress to 'none recorded':
 *
 *  1. Command failure (verifyChanges returns r.passed=false with cmd metadata)
 *     persists stdout, stderr, exitCode, gate name, and cmd in the errorOutput
 *     passed to the recovery handler — recovery prompts have full context.
 *
 *  2. Structural crash (verifyChanges throws) persists a non-empty verifyOutput
 *     on the task row and records failureReasonCode='verify:step-threw'.
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
  tmpRepo = mkdtempSync(join(tmpdir(), 'mars-verify-diag-'))
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
// Case 1: command failure persists stdout+stderr+exitCode+gate identity
// ---------------------------------------------------------------------------

describe('verify — command failure persists stdout+stderr+exitCode+gate identity', () => {
  it('errorOutput passed to handleTaskFailureWithFixTask contains all diagnostic tokens', async () => {
    mockVerifyChanges.mockResolvedValue({
      passed: false,
      steps: [
        {
          name: 'test',
          passed: false,
          output: 'STDOUT_TOKEN\nSTDERR_TOKEN',
          stdout: 'STDOUT_TOKEN',
          stderr: 'STDERR_TOKEN',
          exitCode: 2,
          cmd: 'npm',
          args: ['test'],
          stepDir: '.',
          tier: 'task' as const,
        },
      ],
    })

    const taskId = 'mars-diag-cmd01'
    await expect(
      review(makeCtx(taskId), { kind: 'fix', worktree: worktree(taskId) }),
    ).rejects.toThrow()

    expect(mockHandleTaskFailureWithFixTask).toHaveBeenCalledTimes(1)
    const failureInput = mockHandleTaskFailureWithFixTask.mock.calls[0][0] as Record<
      string,
      unknown
    >
    const errorOutput = failureInput.errorOutput as string

    // Must include the stdout token so recovery has the full output context.
    expect(errorOutput).toContain('STDOUT_TOKEN')
    // Must include the stderr token.
    expect(errorOutput).toContain('STDERR_TOKEN')
    // Must include exit code — recovery needs to know the gate exited non-zero.
    expect(errorOutput).toContain('exitCode: 2')
    // Must include the gate name.
    expect(errorOutput).toContain('test')
    // Must include the full command (cmd + args joined).
    expect(errorOutput).toContain('npm test')
  })

})

// ---------------------------------------------------------------------------
// Case 2: structural verify crash persists non-empty verifyOutput
// ---------------------------------------------------------------------------

describe('verify — structural verify crash persists non-empty verifyOutput', () => {
  it('updateTask is called with failureReasonCode=verify:step-threw and verifyOutput containing BOOM', async () => {
    mockVerifyChanges.mockRejectedValue(new Error('BOOM'))

    const taskId = 'mars-diag-crash01'
    await expect(
      review(makeCtx(taskId), { kind: 'fix', worktree: worktree(taskId) }),
    ).rejects.toThrow('BOOM')

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    const payload = failedCalls[0][1] as Record<string, unknown>

    // The outer catch must stamp verify:step-threw — not the deliberate-failure code.
    expect(payload.failureReasonCode).toBe('verify:step-threw')
    // verifyOutput must be a non-empty string so diagnostics are never 'none recorded'.
    expect(typeof payload.verifyOutput).toBe('string')
    expect((payload.verifyOutput as string).length).toBeGreaterThan(0)
    // Must contain the original error message so post-mortems are diagnosable.
    expect(payload.verifyOutput as string).toContain('BOOM')
  })
})
