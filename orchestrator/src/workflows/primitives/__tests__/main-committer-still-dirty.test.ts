/**
 * Regression / acceptance tests for the main-committer-still-dirty short-circuit
 * (slice 3 of PRD 489270a0).
 *
 * When the post-verify clean check finds the integration branch still dirty after
 * the main-committer task ran, the verify primitive must:
 *   - stamp the committer task failed with failureReasonCode
 *     'orchestration:main-committer-still-dirty'
 *   - raise exactly one action-queue alert naming the contaminated paths
 *   - NOT call handleTaskFailureWithFixTask (no recovery fix task)
 *   - throw so the pipeline aborts (no successful `{ verified: true }` return)
 *
 * Dependents remain 'blocked' because handleTaskFailureWithFixTask is never
 * called (so no fix task is spawned to unblock them), and releaseMainCommitter-
 * Failure keeps dependents parked behind the failed committer; a later dirty
 * episode reparents them to a fresh committer.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  mockRunTool,
  mockCheckIntegrationBranchDirty,
  mockParseMainCommiterPayload,
  mockRaiseActionQueueItem,
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
  mockHandleTaskFailureWithFixTask: vi
    .fn()
    .mockResolvedValue({ outcome: 'fix-task-spawned' }),
  mockRunTool: vi.fn(),
  // Default: clean (the pre-verify main-dirty check passes through)
  mockCheckIntegrationBranchDirty: vi.fn().mockResolvedValue({ dirty: false, statusOutput: '' }),
  // Default: return null (non-committer task). Tests override per-case.
  mockParseMainCommiterPayload: vi.fn().mockReturnValue(null),
  mockRaiseActionQueueItem: vi.fn().mockResolvedValue('aq-item-1'),
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

vi.mock('../../../core/lib/run-tool', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/run-tool')>()
  return { ...orig, runTool: mockRunTool }
})

// Mock main-dirty: MAIN_COMMITER_RECIPE must match what parseMainCommiterPayload returns.
const MOCK_RECIPE = 'main-committer-recipe'
vi.mock('../../../core/lib/main-dirty', () => ({
  checkIntegrationBranchDirty: mockCheckIntegrationBranchDirty,
  MAIN_COMMITER_RECIPE: MOCK_RECIPE,
  spawnOrAttachMainCommitter: vi.fn(),
  parseMainCommiterPayload: mockParseMainCommiterPayload,
}))

// Mock action-queue so raiseActionQueueItem doesn't hit the database.
vi.mock('../../../core/lib/action-queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/action-queue')>()
  return { ...orig, raiseActionQueueItem: mockRaiseActionQueueItem }
})

// Prevent getTask / resolveOriginIdForTask from touching PGlite on cold start.
vi.mock('../../../core/lib/origin', () => ({
  resolveOriginIdForTask: vi.fn().mockImplementation(async (id: string) => id),
}))

// Import the primitive AFTER vi.mock() calls are hoisted.
const { review } = await import('../index')

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let tmpRepo: string

vi.stubGlobal('process', {
  ...process,
  env: { ...process.env },
})

beforeEach(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'mars-mc-still-dirty-'))
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
  mockHandleTaskFailureWithFixTask
    .mockClear()
    .mockResolvedValue({ outcome: 'fix-task-spawned' })
  mockRunTool.mockReset().mockResolvedValue({
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    traceEventId: 'x',
  })
  mockCheckIntegrationBranchDirty.mockClear().mockResolvedValue({ dirty: false, statusOutput: '' })
  mockParseMainCommiterPayload.mockClear().mockReturnValue(null)
  mockRaiseActionQueueItem.mockClear().mockResolvedValue('aq-item-1')
})

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal MarsCtx stub for a fix task (kind='fix'). */
const makeCtx = (taskId: string) =>
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

const worktree = (taskId: string) => ({
  path: `/tmp/wt-${taskId}`,
  branch: `task/${taskId}`,
})

/** Serialised recovery payload that parseMainCommiterPayload recognises as a committer. */
const mainCommitterPayload = JSON.stringify({ recipe: MOCK_RECIPE, integrationBranch: 'main' })

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

describe('main-committer-still-dirty — verify primitive', () => {
  it('stamps the task failed with failureReasonCode orchestration:main-committer-still-dirty', async () => {
    const taskId = 'mars-mc-dirty-01'
    // parseMainCommiterPayload recognises the payload → isMainCommitter = true
    mockParseMainCommiterPayload.mockReturnValue({ recipe: MOCK_RECIPE })
    // verifyChanges passes (the committer's own verify steps succeed)
    mockVerifyChanges.mockResolvedValue({
      passed: true,
      steps: [{ name: 'has-diff', passed: true, output: 'ok', tier: 'task' }],
    })
    // But the post-clean check finds dirt
    mockCheckIntegrationBranchDirty.mockResolvedValue({
      dirty: true,
      statusOutput: ' M orchestrator/src/foo.ts\n?? orchestrator/src/bar.ts\n',
    })

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: worktree(taskId),
        recoveryPayload: mainCommitterPayload,
      }),
    ).rejects.toThrow()

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    const [id, patch] = failedCalls[0] as [string, Record<string, unknown>]
    expect(id).toBe(taskId)
    expect(patch.failureReasonCode).toBe('orchestration:main-committer-still-dirty')
    expect(patch.failureReason).toBe('orchestration:main-committer-still-dirty')
    expect(patch.failedPhase).toBe('verify')
  })

  it('does NOT call handleTaskFailureWithFixTask — no fix task is spawned', async () => {
    const taskId = 'mars-mc-dirty-02'
    mockParseMainCommiterPayload.mockReturnValue({ recipe: MOCK_RECIPE })
    mockVerifyChanges.mockResolvedValue({
      passed: true,
      steps: [{ name: 'has-diff', passed: true, output: 'ok', tier: 'task' }],
    })
    mockCheckIntegrationBranchDirty.mockResolvedValue({
      dirty: true,
      statusOutput: ' M some/file.ts\n',
    })

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: worktree(taskId),
        recoveryPayload: mainCommitterPayload,
      }),
    ).rejects.toThrow()

    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
  })

  it('raises exactly one action-queue row with the committer-still-dirty signature', async () => {
    const taskId = 'mars-mc-dirty-03'
    mockParseMainCommiterPayload.mockReturnValue({ recipe: MOCK_RECIPE })
    mockVerifyChanges.mockResolvedValue({
      passed: true,
      steps: [{ name: 'has-diff', passed: true, output: 'ok', tier: 'task' }],
    })
    mockCheckIntegrationBranchDirty.mockResolvedValue({
      dirty: true,
      statusOutput: ' M src/dirty.ts\n',
    })

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: worktree(taskId),
        recoveryPayload: mainCommitterPayload,
      }),
    ).rejects.toThrow()

    expect(mockRaiseActionQueueItem).toHaveBeenCalledTimes(1)
    const [aqOpts] = mockRaiseActionQueueItem.mock.calls[0] as [Record<string, unknown>]
    expect(aqOpts.signature).toBe(`main-committer-still-dirty:${taskId}`)
    expect(aqOpts.kind).toBe('failed')
    expect(aqOpts.priority).toBe('high')
    expect(aqOpts.title).toBe('main is dirty: src/dirty.ts')
  })

  it('throws a terminal error so the pipeline aborts (does not return verified:true)', async () => {
    const taskId = 'mars-mc-dirty-04'
    mockParseMainCommiterPayload.mockReturnValue({ recipe: MOCK_RECIPE })
    mockVerifyChanges.mockResolvedValue({
      passed: true,
      steps: [{ name: 'has-diff', passed: true, output: 'ok', tier: 'task' }],
    })
    mockCheckIntegrationBranchDirty.mockResolvedValue({
      dirty: true,
      statusOutput: ' M x.ts\n',
    })

    const result = review(makeCtx(taskId), {
      kind: 'fix',
      worktree: worktree(taskId),
      recoveryPayload: mainCommitterPayload,
    })
    await expect(result).rejects.toThrow(/main-committer-still-dirty|committer-still-dirty/)
  })
})

// ---------------------------------------------------------------------------
// Existing verify() behaviour is unchanged for normal (non-committer) tasks
// ---------------------------------------------------------------------------

describe('existing verify() behaviour — non-committer fix tasks are unaffected', () => {
  it('non-committer fix task with passing verify returns verified:true normally', async () => {
    const taskId = 'mars-mc-noaffect-01'
    // parseMainCommiterPayload returns null → not a main-committer → post-clean check skipped
    mockParseMainCommiterPayload.mockReturnValue(null)
    mockRunTool.mockImplementation(async (input: { argv: string[] }) => {
      if (input.argv[0] === 'rev-list' && input.argv[1] === '--count') {
        return { exitCode: 0, stdout: '1\n', stderr: '', durationMs: 1, traceEventId: 'x' }
      }
      if (input.argv[0] === 'merge-base') {
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 1, traceEventId: 'x' }
      }
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, traceEventId: 'x' }
    })
    mockVerifyChanges.mockResolvedValue({
      passed: true,
      steps: [{ name: 'has-diff', passed: true, output: 'ok', tier: 'task' }],
    })

    const result = await review(makeCtx(taskId), {
      kind: 'fix',
      worktree: worktree(taskId),
      recoveryPayload: null,
    })
    expect(result).toEqual({ verified: true })
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
  })

  it('clean post-check on a main-committer task → verify passes without raising an alert', async () => {
    const taskId = 'mars-mc-clean-01'
    mockParseMainCommiterPayload.mockReturnValue({ recipe: MOCK_RECIPE })
    // Branch-contamination guard: 1 commit ahead, not an ancestor of integration
    mockRunTool.mockImplementation(async (input: { argv: string[] }) => {
      if (input.argv[0] === 'rev-list' && input.argv[1] === '--count') {
        return { exitCode: 0, stdout: '1\n', stderr: '', durationMs: 1, traceEventId: 'x' }
      }
      if (input.argv[0] === 'merge-base') {
        // exit 1 → NOT an ancestor → no contamination
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 1, traceEventId: 'x' }
      }
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, traceEventId: 'x' }
    })
    mockVerifyChanges.mockResolvedValue({
      passed: true,
      steps: [{ name: 'has-diff', passed: true, output: 'ok', tier: 'task' }],
    })
    // Post-clean check returns clean
    mockCheckIntegrationBranchDirty.mockResolvedValue({ dirty: false, statusOutput: '' })

    const result = await review(makeCtx(taskId), {
      kind: 'fix',
      worktree: worktree(taskId),
      recoveryPayload: mainCommitterPayload,
    })
    expect(result).toEqual({ verified: true })
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
  })
})
