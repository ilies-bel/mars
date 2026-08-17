/**
 * Regression test for the post-coder-classifier-error fix (task mars-33079864).
 *
 * Root cause: when `detectPostCoderState` returned `{ kind: 'error' }` after the
 * corrective coder turn the caller silently kept the stale pre-correction snapshot
 * and fed it into Stage 2 (the auto-commit net) and, on refusal, into
 * `coderUncommittedFailure(...)`, which reported stale dirty-file counts as if
 * freshly measured. An operator reading the failure believed the work had been
 * lost and ran `mars restart`, deleting a worktree whose corrective turn may have
 * successfully committed all of the files.
 *
 * Fix: on error, retry once. If the retry also errors, fail with the distinct
 * `code/post-coder-classifier-error` signature whose message tells the operator
 * to inspect the worktree and prefer `mars continue` over `mars restart`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { WorkflowTerminalError } from '../../../core/lib/workflow-terminal-error'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockUpdateTask,
  mockHandleTaskFailureWithFixTask,
  mockRunWorkerWithSpan,
  mockResolveOriginIdForTask,
  mockCleanWorktreeIfNoCommitsAhead,
  mockFetchLessonsForTask,
  mockListMergedWorkers,
  mockRecordSignals,
  mockRaiseActionQueueItem,
  mockSyncWorktreeToIntegration,
  mockRestoreWorktreeIfMissing,
  mockDetectPostCoderState,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockHandleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
  mockRunWorkerWithSpan: vi.fn(),
  mockResolveOriginIdForTask: vi.fn().mockImplementation(async (id: string) => id),
  mockCleanWorktreeIfNoCommitsAhead: vi
    .fn()
    .mockResolvedValue({ cleaned: false, reason: 'skipped for test', output: '' }),
  mockFetchLessonsForTask: vi.fn().mockResolvedValue([]),
  mockListMergedWorkers: vi.fn().mockReturnValue([]),
  mockRecordSignals: vi.fn().mockResolvedValue(undefined),
  mockRaiseActionQueueItem: vi.fn().mockResolvedValue(undefined),
  mockSyncWorktreeToIntegration: vi.fn().mockResolvedValue({ kind: 'already-current' }),
  mockRestoreWorktreeIfMissing: vi.fn().mockResolvedValue('present'),
  mockDetectPostCoderState: vi.fn(),
}))

vi.mock('../shared', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../shared')>()
  return { ...orig, detectPostCoderState: mockDetectPostCoderState }
})

vi.mock('../../../core/lib/git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/worktree')>()
  return {
    ...orig,
    syncWorktreeToIntegration: mockSyncWorktreeToIntegration,
    restoreWorktreeIfMissing: mockRestoreWorktreeIfMissing,
  }
})

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return { ...orig, updateTask: mockUpdateTask }
})

vi.mock('../../../core/queue-fix-tasks', () => ({
  handleTaskFailureWithFixTask: mockHandleTaskFailureWithFixTask,
}))

vi.mock('../../../core/lib/origin', () => ({
  resolveOriginIdForTask: mockResolveOriginIdForTask,
}))

vi.mock('../../../core/lib/git/verify', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/verify')>()
  return {
    ...orig,
    cleanWorktreeIfNoCommitsAhead: mockCleanWorktreeIfNoCommitsAhead,
  }
})

vi.mock('../../../core/lib/run-worker-with-span', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/run-worker-with-span')>()
  return { ...orig, runWorkerWithSpan: mockRunWorkerWithSpan }
})

vi.mock('../../../core/store/memory-packet-store', () => ({
  resolveTaskDomains: vi.fn().mockReturnValue([]),
  fetchLessonsForTask: mockFetchLessonsForTask,
}))

vi.mock('../../../core/workers/persisted-registry', () => ({
  listMergedWorkers: mockListMergedWorkers,
}))

vi.mock('../../../core/lib/reflect-signals', () => ({
  recordSignals: mockRecordSignals,
  isReflectDisabled: vi.fn().mockReturnValue(false),
}))

vi.mock('../../../core/lib/action-queue', () => ({
  raiseActionQueueItem: mockRaiseActionQueueItem,
}))

const { runAgent } = await import('../index')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(taskId: string, store: object, traceStore: object | null = null) {
  return {
    runId: taskId,
    workflowId: 'task',
    input: {
      taskId,
      kind: 'task',
      prompt: 'implement it',
      tags: ['coder'],
    },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store,
      traceStore,
      onPid: vi.fn(),
    },
    currentStep: null,
    emit: vi.fn(),
    step: vi.fn(),
  } as never
}

function makeStore() {
  return {
    getTask: vi.fn().mockResolvedValue(null),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    batch: vi.fn().mockResolvedValue([]),
  }
}

function cleanCoderResult() {
  return {
    exitCode: 0,
    stderr: '',
    stdout: '',
    sessionId: 'sess-1',
    conversation: [],
    quotaRejected: null,
  }
}

function initRepo(): string {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-classifier-error-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README'), 'hello\n')
  execFileSync('git', ['add', 'README'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['checkout', '-q', '-b', 'task/test-classifier-error', 'main'], { cwd: repo })
  return repo
}

// ---------------------------------------------------------------------------
// Regression: classifier error after corrective turn must NOT reuse stale state
// ---------------------------------------------------------------------------

describe('post-coder-classifier-error — stale-snapshot regression (mars-33079864)', () => {
  let repo: string

  beforeEach(() => {
    repo = initRepo()
    vi.clearAllMocks()
    mockUpdateTask.mockResolvedValue(undefined)
    mockHandleTaskFailureWithFixTask.mockResolvedValue({ outcome: 'fix-task-spawned' })
    mockResolveOriginIdForTask.mockImplementation(async (id: string) => id)
    mockCleanWorktreeIfNoCommitsAhead.mockResolvedValue({
      cleaned: false,
      reason: 'skipped for test',
      output: '',
    })
    mockFetchLessonsForTask.mockResolvedValue([])
    mockListMergedWorkers.mockReturnValue([])
    mockRecordSignals.mockResolvedValue(undefined)
    mockRaiseActionQueueItem.mockResolvedValue(undefined)
    mockRestoreWorktreeIfMissing.mockResolvedValue('present')
    // Both coder turns complete without committing (the corrective turn also
    // exits 0 without committing — that is the scenario where the worktree
    // may actually be clean but the classifier cannot confirm it).
    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('fails with code/post-coder-classifier-error, NOT code/uncommitted-changes, when the classifier errors after the corrective turn', async () => {
    // Call sequence for detectPostCoderState in this scenario:
    //   Call 1 (initial, line ~2101): dirty-no-commits with a pre-correction list
    //   Call 2 (post-correction, line ~2236): error — simulates the transient rev-list failure
    //   Call 3 (retry of call 2):             error — persists; the problem is not transient
    const PRE_CORRECTION_DIRTY_FILES = ['src/a.ts', 'src/b.ts', 'src/c.ts']
    const CLASSIFIER_ERROR =
      "rev-list main..HEAD failed (exit 128): fatal: ambiguous argument 'main..HEAD': unknown revision or path not in the working tree."

    let callCount = 0
    mockDetectPostCoderState.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return { kind: 'dirty-no-commits', dirtyFiles: PRE_CORRECTION_DIRTY_FILES }
      }
      return { kind: 'error', error: CLASSIFIER_ERROR }
    })

    const ctx = makeCtx('test-classifier-error', makeStore())
    await expect(
      runAgent(ctx, {
        worktree: { path: repo, branch: 'task/test-classifier-error' },
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    // The failure must carry the new, honest signature — NOT the stale
    // CODER_UNCOMMITTED_SIGNATURE that names files measured 5+ minutes ago.
    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    expect((failedCalls[0][1] as Record<string, unknown>).failureSignature).toBe(
      'code/post-coder-classifier-error',
    )
    expect((failedCalls[0][1] as Record<string, unknown>).failureSignature).not.toBe(
      'code/uncommitted-changes',
    )

    // The error text must NOT carry the stale pre-correction dirty-file list
    // as if it were a freshly-measured fact — that is what misled the operator
    // into running `mars restart`.
    const errorText = (failedCalls[0][1] as Record<string, unknown>).error as string
    expect(errorText).not.toContain('uncommitted changes')
    for (const file of PRE_CORRECTION_DIRTY_FILES) {
      expect(errorText).not.toContain(file)
    }

    // The error must quote the actual classifier error and the worktree path
    // so the operator has actionable context.
    expect(errorText).toContain('could not determine the worktree state')
    expect(errorText).toContain(CLASSIFIER_ERROR)
    expect(errorText).toContain(repo)

    // The action-queue item must be raised once with the new signature.
    expect(mockRaiseActionQueueItem).toHaveBeenCalledTimes(1)
    expect(mockRaiseActionQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'failed',
        raisedBy: 'workflow:code:post-coder-classifier-error',
      }),
    )

    // detectPostCoderState must have been called 3 times:
    //   1. initial classification
    //   2. post-correction classification
    //   3. one retry of the post-correction classification
    expect(callCount).toBe(3)

    // The old CODER_UNCOMMITTED_SIGNATURE must NOT have been stamped.
    const uncommittedCalls = mockUpdateTask.mock.calls.filter(
      (c) =>
        (c[1] as Record<string, unknown>)?.failureSignature === 'code/uncommitted-changes',
    )
    expect(uncommittedCalls).toHaveLength(0)
  })

  it('uses the retry result when the first post-correction check errors but the retry succeeds', async () => {
    // If the transient hiccup resolves on the one allowed retry, we should
    // proceed normally — either accepting the corrective turn's commits or
    // falling through to the auto-commit net — rather than failing the task.
    // This test asserts the "happy retry" branch.
    let callCount = 0
    mockDetectPostCoderState.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        // Initial check: dirty (coder left work uncommitted)
        return { kind: 'dirty-no-commits', dirtyFiles: ['src/x.ts'] }
      }
      if (callCount === 2) {
        // Post-correction first attempt: transient error
        return { kind: 'error', error: 'rev-list exited 128 (transient)' }
      }
      // Retry succeeds: corrective turn committed the work
      return { kind: 'clean-with-commits', commitsAhead: 1 }
    })

    const ctx = makeCtx('test-classifier-error', makeStore())
    // Should NOT throw — the corrective turn succeeded on the retry path
    const result = await runAgent(ctx, {
      worktree: { path: repo, branch: 'task/test-classifier-error' },
    })

    expect(result).toHaveProperty('sessionId', 'sess-1')
    expect(callCount).toBe(3)

    // No failure was stamped
    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(0)
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
  })
})
