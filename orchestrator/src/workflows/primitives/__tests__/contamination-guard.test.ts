/**
 * Regression tests for the branch-contamination guard fix (mars-0818b3bc).
 *
 * Root cause: `git merge-base --is-ancestor HEAD <integration>` exits 0 for
 * ANY zero-commit branch (the branch tip is a commit already on the integration
 * timeline), so the guard incorrectly hard-failed every task that legitimately
 * produced no commits with `verify:branch-contaminated`.
 *
 * Fix: count commits ahead first (`rev-list --count integration..HEAD`). A
 * zero-ahead count means verifyChanges handles the shape (no-op accepted or
 * work already merged); only a positive count can indicate genuine external
 * repointing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetContextCacheForTests } from '../../../core/context'

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before any vi.mock() factory runs
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
  mockRunTool,
  mockCheckIntegrationBranchDirty,
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
  mockRunTool: vi.fn(),
  mockCheckIntegrationBranchDirty: vi.fn().mockResolvedValue({ dirty: false }),
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

// Mock runTool so git commands don't spawn real processes.
vi.mock('../../../core/lib/run-tool', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/run-tool')>()
  return { ...orig, runTool: mockRunTool }
})

// Mock main-dirty so the dirty-integration-branch check does not spawn git.
vi.mock('../../../core/lib/main-dirty', () => ({
  checkIntegrationBranchDirty: mockCheckIntegrationBranchDirty,
  MAIN_COMMITER_RECIPE: 'main-committer-recipe',
  spawnOrAttachMainCommitter: vi.fn(),
  parseMainCommiterPayload: vi.fn().mockReturnValue(null),
}))

// Mock origin so resolveOriginIdForTask never hits the database.
// Without this, the first test in an isolated run initialises PGlite which
// can take >5 s on cold start and trips the default vitest timeout.
vi.mock('../../../core/lib/origin', () => ({
  resolveOriginIdForTask: vi.fn().mockImplementation(async (id: string) => id),
}))

// Import the primitive AFTER vi.mock() calls are hoisted.
const { review } = await import('../index')

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let tmpRepo: string

beforeAll(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'mars-contamination-guard-'))
})

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

/** Minimal MarsCtx stub using kind: 'task' to exercise the contamination guard. */
const makeCtx = (taskId: string) =>
  ({
    runId: taskId,
    workflowId: 'task',
    input: { taskId, kind: 'task' },
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

const worktree = (taskId: string) => ({
  path: `/tmp/wt-${taskId}`,
  branch: `task/${taskId}`,
})

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
  mockCheckIntegrationBranchDirty.mockClear().mockResolvedValue({ dirty: false })
  mockRunTool.mockReset()
})

// ---------------------------------------------------------------------------
// Regression: zero-commit branch must NOT trigger verify:branch-contaminated
// ---------------------------------------------------------------------------

describe('contamination guard — zero-commit task branch', () => {
  it('falls through to verifyChanges and returns passed:true (no-op accepted)', async () => {
    // rev-list --count integration..HEAD returns 0 (no task-specific commits)
    mockRunTool.mockImplementation(async (input: { argv: string[] }) => {
      if (input.argv[0] === 'rev-list' && input.argv[1] === '--count') {
        return { exitCode: 0, stdout: '0\n', stderr: '', durationMs: 1, traceEventId: 'x' }
      }
      // Anything else: safe fallback (the --is-ancestor branch should NOT be reached,
      // but returning a non-0 exit code here keeps the test symmetric with test 2).
      return { exitCode: 1, stdout: '', stderr: '', durationMs: 1, traceEventId: 'x' }
    })

    mockVerifyChanges.mockResolvedValue({
      passed: true,
      steps: [
        {
          name: 'has-diff',
          passed: true,
          output: 'branch task/mars-nocommit01 tip equals main — no-op accepted',
          tier: 'task',
        },
      ],
    })

    const taskId = 'mars-nocommit01'
    const result = await review(makeCtx(taskId), { kind: 'task', worktree: worktree(taskId) })

    expect(result).toEqual({ verified: true })

    // Must NOT have been stamped failed at all
    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(0)

    // verifyChanges must have been reached
    expect(mockVerifyChanges).toHaveBeenCalledTimes(1)
  })

  it('does not set failureReason to verify:branch-contaminated', async () => {
    // Simulates the historical bug: the old code would run --is-ancestor before
    // the count check. A zero-commit branch has HEAD == integration tip, so
    // --is-ancestor returns exit 0 and the task was hard-failed.
    mockRunTool.mockImplementation(async (input: { argv: string[] }) => {
      if (input.argv[0] === 'rev-list' && input.argv[1] === '--count') {
        return { exitCode: 0, stdout: '0\n', stderr: '', durationMs: 1, traceEventId: 'x' }
      }
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, traceEventId: 'x' }
    })

    mockVerifyChanges.mockResolvedValue({
      passed: true,
      steps: [{ name: 'has-diff', passed: true, output: 'no-op accepted', tier: 'task' }],
    })

    const taskId = 'mars-nocommit02'
    await review(makeCtx(taskId), { kind: 'task', worktree: worktree(taskId) })

    const contamCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.failureReason === 'verify:branch-contaminated',
    )
    expect(contamCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Guard: positive-commit contaminated branch still fails as before
// ---------------------------------------------------------------------------

describe('contamination guard — positive-commit contaminated branch', () => {
  it('hard-fails with verify:branch-contaminated when rev-list count > 0 and HEAD is on integration', async () => {
    // Branch has 2 commits but they're reachable from integration (contamination).
    mockRunTool.mockImplementation(async (input: { argv: string[] }) => {
      if (input.argv[0] === 'rev-list' && input.argv[1] === '--count') {
        return { exitCode: 0, stdout: '2\n', stderr: '', durationMs: 1, traceEventId: 'x' }
      }
      if (input.argv[0] === 'merge-base' && input.argv[1] === '--is-ancestor') {
        // 0 = HEAD is an ancestor of integration → contamination
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, traceEventId: 'x' }
      }
      if (input.argv[0] === 'rev-parse' && input.argv[1] === '--short') {
        return { exitCode: 0, stdout: 'abc1234\n', stderr: '', durationMs: 1, traceEventId: 'x' }
      }
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, traceEventId: 'x' }
    })

    const taskId = 'mars-contam01'
    await expect(
      review(makeCtx(taskId), { kind: 'task', worktree: worktree(taskId) }),
    ).rejects.toThrow('verify:branch-contaminated')

    const contamCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.failureReason === 'verify:branch-contaminated',
    )
    expect(contamCalls).toHaveLength(1)
    expect(contamCalls[0][0]).toBe(taskId)
    expect((contamCalls[0][1] as Record<string, unknown>).status).toBe('failed')
    expect((contamCalls[0][1] as Record<string, unknown>).failedPhase).toBe('verify')

    // verifyChanges must NOT have been reached — the guard short-circuits
    expect(mockVerifyChanges).not.toHaveBeenCalled()
  })
})
