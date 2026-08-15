/**
 * code/empty-diff guard — regression cover for the silent-bail scenario.
 *
 * Root cause (mars-f2a5d4ea): a coder that exits code 0 without making any
 * commit (clean-no-work state) was treated as a benign no-op. The task
 * flowed through verify (has-diff passes 0-ahead as no-op) and merge (zero-
 * commit short-circuit sets status='done'), appearing successful while
 * producing zero work. A substantial "build the dashboard app" prompt
 * completed as 'done' with no code change at all.
 *
 * Fix: the code phase detects `clean-no-work` after a successful coder exit
 * and fails the task with `code/empty-diff` so recovery/action-queue handles
 * it. Exception: `main-committer` recovery tasks are exempt because their
 * correct success state IS zero commits (the integration branch self-healed
 * before they ran).
 *
 * Verify (integration test):
 *   - A coder stub that exits without committing must produce a failed task
 *     with failureSignature `code/empty-diff`, never 'done'.
 *   - A main-committer recovery task that exits without committing must NOT
 *     fail with `code/empty-diff` — it succeeds as a no-op.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { WorkflowTerminalError } from '../../../core/lib/workflow-terminal-error'

// ---------------------------------------------------------------------------
// Hoisted mocks — accessible inside vi.mock() factories AND test bodies
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
  mockParseMainCommiterPayload,
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
  mockParseMainCommiterPayload: vi.fn().mockReturnValue(null),
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

// `main-dirty` is dynamically imported inside the empty-diff guard. Mock it
// so the real module's pg/git calls are never spawned in unit tests. The mock
// exposes `MAIN_COMMITER_RECIPE` so the isMainCommitter comparison resolves
// to the same constant both inside the guard and in the test body.
vi.mock('../../../core/lib/main-dirty', () => ({
  MAIN_COMMITER_RECIPE: 'main-commiter',
  parseMainCommiterPayload: mockParseMainCommiterPayload,
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

function makeStore(taskOverrides: Record<string, unknown> = {}) {
  return {
    getTask: vi.fn().mockResolvedValue(Object.keys(taskOverrides).length ? taskOverrides : null),
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

/** Create a bare git repo with `main` and a task branch at the same tip. */
function initRepo(): string {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-empty-diff-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  // Write the initial commit on main
  const { writeFileSync } = require('node:fs') as typeof import('node:fs')
  writeFileSync(resolve(repo, 'README'), 'hello\n')
  execFileSync('git', ['add', 'README'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  // Create the task branch at the same commit — zero commits ahead of main
  execFileSync('git', ['checkout', '-q', '-b', 'task/test-empty', 'main'], { cwd: repo })
  return repo
}

/** Count commits on the task branch ahead of main. */
function commitsAhead(repo: string): number {
  const out = execFileSync('git', ['rev-list', '--count', 'main..HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  })
  return Number.parseInt(out.trim(), 10)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('code/empty-diff guard — coder exits with zero commits', () => {
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
    // Default: not a main-committer task
    mockParseMainCommiterPayload.mockReturnValue(null)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('throws WorkflowTerminalError when coder exits without committing anything', async () => {
    // Coder exits cleanly but produces no commits — tree is still clean
    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())

    const ctx = makeCtx('test-empty', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-empty' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    // The branch must still have zero commits ahead of main
    expect(commitsAhead(repo)).toBe(0)
  })

  it('stamps failureSignature code/empty-diff on the task', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())

    const ctx = makeCtx('test-empty', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-empty' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    const [calledId, patch] = failedCalls[0] as [string, Record<string, unknown>]
    expect(calledId).toBe('test-empty')
    expect(patch.failureSignature).toBe('code/empty-diff')
    expect(patch.failedPhase).toBe('code')
    expect(patch.failureReasonCode).toBe('code/empty-diff')
  })

  it('never sets status done when coder exits without committing', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())

    const ctx = makeCtx('test-empty', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-empty' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const doneCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'done',
    )
    expect(doneCalls).toHaveLength(0)
  })

  it('error message contains the empty-diff classifier keyword', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())

    const ctx = makeCtx('test-empty', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-empty' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    const patch = failedCalls[0][1] as Record<string, unknown>
    // The error text must contain the phrase that error-classifies as
    // 'empty-diff' so the recovery-spawn subscriber can recompute the same
    // signature via computeFailureSignature('code', task.error).
    expect(patch.error).toMatch(/produced zero commits — empty diff/i)
  })
})

describe('code/empty-diff guard — main-committer exception', () => {
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
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('does NOT fail with code/empty-diff when the task is a main-committer recovery', async () => {
    // main-committer recovery task: parseMainCommiterPayload returns a valid payload
    const committerPayload = { recipe: 'main-commiter', integrationBranch: 'main' }
    mockParseMainCommiterPayload.mockReturnValue(committerPayload)

    // Coder exits cleanly, nothing committed — integration branch was already clean
    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())

    // Store returns a task with a main-committer recovery_payload
    const store = makeStore({
      id: 'test-committer',
      recoveryPayload: JSON.stringify(committerPayload),
    })

    const ctx = makeCtx('test-committer', store)
    // Must NOT throw — the no-op is legitimate for a main-committer
    const result = await runAgent(ctx, {
      worktree: { path: repo, branch: 'task/test-committer' },
    })

    // Completes (returns a result, doesn't throw)
    expect(result).toHaveProperty('sessionId')

    // Must NOT have stamped code/empty-diff
    const emptyDiffCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.failureSignature === 'code/empty-diff',
    )
    expect(emptyDiffCalls).toHaveLength(0)
  })
})
