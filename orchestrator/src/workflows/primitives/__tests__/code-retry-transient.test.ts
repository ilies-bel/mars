/**
 * Tests for the at-most-two-attempt retry loop in `runAgent`.
 *
 * A retryable-transient exit (e.g. SIGKILL with zero provider messages) on
 * attempt 1 triggers exactly one re-dispatch on a fresh session key.  The
 * second attempt's result flows into the existing handlers unchanged.
 *
 * Acceptance criteria:
 *   a) transient exit followed by success → task completes cleanly, no fix-task
 *   b) two transient exits → fix-task spawned exactly once
 *   c) operator abort mid-attempt → no retry, throws "stopped by operator"
 *   d) context-exhausted first attempt → no retry
 *   e) quota-rejected first attempt → no retry
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { WorkflowTerminalError } from '../../../core/lib/workflow-terminal-error'

// ---------------------------------------------------------------------------
// Hoisted mocks — same surface as coder-exit-checkpoint.test.ts
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
  mockSyncWorktreeToIntegration,
  mockRestoreWorktreeIfMissing,
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
  mockSyncWorktreeToIntegration: vi.fn().mockResolvedValue({ kind: 'already-current' }),
  mockRestoreWorktreeIfMissing: vi.fn().mockResolvedValue('present'),
}))

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
  return { ...orig, cleanWorktreeIfNoCommitsAhead: mockCleanWorktreeIfNoCommitsAhead }
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

// Import runAgent AFTER vi.mock() hoisting is complete.
const { runAgent } = await import('../index')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal MarsCtx stub. Accepts an optional AbortSignal for the abort tests. */
function makeCtx(taskId: string, store: object, signal?: AbortSignal) {
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
    signal: signal ?? new AbortController().signal,
    services: {
      store,
      traceStore: null,
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

/**
 * Retryable-transient result: SIGKILL (exit 137) with zero provider messages.
 * `classifyCoderExitDisposition` classifies this as `retryable-transient` with
 * reason `sigkill-no-progress`.
 */
function transientResult() {
  return {
    exitCode: 137,
    stderr: '',
    stdout: '',
    sessionId: null,
    conversation: [] as unknown[], // zero messages — no provider contact
    quotaRejected: null as null,
  }
}

/** Exit-0 success result. */
function successResult() {
  return {
    exitCode: 0,
    stderr: '',
    stdout: '',
    sessionId: null,
    conversation: [{ type: 'assistant', content: 'done' }] as unknown[],
    quotaRejected: null as null,
  }
}

/** Initialize a temp git repo branched off main with a commit ahead of main. */
function initRepoWithCommit(): string {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-retry-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README'), 'hello\n')
  execFileSync('git', ['add', 'README'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['checkout', '-q', '-b', 'task/test-id', 'main'], { cwd: repo })
  // Simulate a successful coder turn already committed to the task branch.
  writeFileSync(resolve(repo, 'feature.ts'), 'export const ok = true\n')
  execFileSync('git', ['add', 'feature.ts'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'feat: feature'], { cwd: repo })
  return repo
}

/** Initialize a temp git repo branched off main with NO commits ahead. */
function initRepo(): string {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-retry-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README'), 'hello\n')
  execFileSync('git', ['add', 'README'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['checkout', '-q', '-b', 'task/test-id', 'main'], { cwd: repo })
  return repo
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAgent — at-most-two-attempt retry loop', () => {
  let repo: string

  beforeEach(() => {
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
    mockRestoreWorktreeIfMissing.mockResolvedValue('present')
    mockSyncWorktreeToIntegration.mockResolvedValue({ kind: 'already-current' })
  })

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  // ── (a) transient exit followed by success ─────────────────────────────────

  describe('(a) transient exit followed by success', () => {
    it('does not spawn a fix-task when attempt 1 is transient and attempt 2 succeeds', async () => {
      repo = initRepoWithCommit()

      // Attempt 1: retryable-transient (SIGKILL, zero messages)
      mockRunWorkerWithSpan.mockResolvedValueOnce(transientResult())
      // Attempt 2: success (exit 0)
      mockRunWorkerWithSpan.mockResolvedValueOnce(successResult())

      const ctx = makeCtx('test-id', makeStore())
      const result = await runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } })

      // The coder ran exactly twice: once for the transient + once for the retry.
      expect(mockRunWorkerWithSpan).toHaveBeenCalledTimes(2)
      // No fix-task was spawned — the retry succeeded without recovery.
      expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
      // runAgent returned successfully.
      expect(result).toEqual({ sessionId: null })
    })

    it('uses a different sessionKey on the retry (fresh UUID suffix)', async () => {
      repo = initRepoWithCommit()

      const sessionKeys: (string | undefined)[] = []
      mockRunWorkerWithSpan.mockImplementation(
        async (opts: { runOptions: { sessionId?: string } }) => {
          sessionKeys.push(opts.runOptions.sessionId)
          // Return transient on first call, success on second.
          return sessionKeys.length === 1 ? transientResult() : successResult()
        },
      )

      const ctx = makeCtx('test-id', makeStore())
      await runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } })

      expect(sessionKeys).toHaveLength(2)
      // Both session keys must be present and distinct.
      expect(sessionKeys[0]).toBeDefined()
      expect(sessionKeys[1]).toBeDefined()
      expect(sessionKeys[0]).not.toBe(sessionKeys[1])
    })
  })

  // ── (b) two transient exits ────────────────────────────────────────────────

  describe('(b) two transient exits', () => {
    it('spawns a fix-task exactly once when both attempts are transient', async () => {
      repo = initRepo()

      // Both attempts return SIGKILL with zero messages.
      mockRunWorkerWithSpan.mockResolvedValue(transientResult())

      const ctx = makeCtx('test-id', makeStore())
      await expect(
        runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } }),
      ).rejects.toBeInstanceOf(WorkflowTerminalError)

      // The worker was called twice: attempt 1 triggered a retry, attempt 2 failed.
      expect(mockRunWorkerWithSpan).toHaveBeenCalledTimes(2)
      // The existing coder-exit-nonzero path fires exactly once for attempt 2.
      expect(mockHandleTaskFailureWithFixTask).toHaveBeenCalledTimes(1)
    })

    it('throws WorkflowTerminalError coder-exit-nonzero on second transient exit', async () => {
      repo = initRepo()
      mockRunWorkerWithSpan.mockResolvedValue(transientResult())

      const ctx = makeCtx('test-id', makeStore())
      await expect(
        runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } }),
      ).rejects.toMatchObject({ kind: 'coder-exit-nonzero' })
    })
  })

  // ── (c) operator abort ─────────────────────────────────────────────────────

  describe('(c) operator abort mid-attempt', () => {
    it('throws "stopped by operator" without a retry when the abort signal fires', async () => {
      repo = initRepo()

      const ac = new AbortController()
      // Abort the signal as soon as the worker call resolves.
      mockRunWorkerWithSpan.mockImplementationOnce(async () => {
        ac.abort()
        return transientResult()
      })

      const ctx = makeCtx('test-id', makeStore(), ac.signal)
      await expect(
        runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } }),
      ).rejects.toThrow('stopped by operator')

      // Only one worker call — the abort check fires before the retry loop can continue.
      expect(mockRunWorkerWithSpan).toHaveBeenCalledTimes(1)
      // No fix-task — operator stop is not a code failure.
      expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
    })
  })

  // ── (d) context-exhausted ──────────────────────────────────────────────────

  describe('(d) context-exhausted first attempt', () => {
    it('does not retry on context-budget exhaustion (terminal-recovery)', async () => {
      repo = initRepo()

      mockRunWorkerWithSpan.mockResolvedValueOnce({
        exitCode: 138,
        stderr: 'context budget exhausted (maxContextTokens)',
        stdout: '',
        sessionId: null,
        conversation: [{}],
        quotaRejected: null,
      })

      const ctx = makeCtx('test-id', makeStore())
      await expect(
        runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } }),
      ).rejects.toMatchObject({ kind: 'context-exhausted' })

      // Only one worker call — context-exhausted is terminal, no retry.
      expect(mockRunWorkerWithSpan).toHaveBeenCalledTimes(1)
      // The context-exhausted handler spawns a fix-task exactly once.
      expect(mockHandleTaskFailureWithFixTask).toHaveBeenCalledTimes(1)
    })
  })

  // ── (e) quota-rejected ─────────────────────────────────────────────────────

  describe('(e) quota-rejected first attempt', () => {
    it('does not retry on a quota rejection (terminal-recovery)', async () => {
      repo = initRepo()

      mockRunWorkerWithSpan.mockResolvedValueOnce({
        exitCode: 1,
        stderr: '',
        stdout: '',
        sessionId: null,
        conversation: [],
        quotaRejected: { resetsAt: 9_999_999_999 },
      })

      const ctx = makeCtx('test-id', makeStore())
      await expect(
        runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } }),
      ).rejects.toMatchObject({ kind: 'quota-rejected' })

      // Only one worker call — quota-rejected is terminal, no retry.
      expect(mockRunWorkerWithSpan).toHaveBeenCalledTimes(1)
      // Quota rejection re-queues the task, NOT via handleTaskFailureWithFixTask.
      expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
    })
  })
})
