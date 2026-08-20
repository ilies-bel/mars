/**
 * Tests for the wip(checkpoint) commit created on abnormal coder exit.
 *
 * When a coder process is killed (watchdog, timeout, quota death) mid-run it
 * can leave completed but uncommitted work in the worktree. Without a
 * checkpoint the recovery fixer starts from a clean tree and has to redo
 * everything. The fix: detect a dirty worktree on non-zero exit and commit
 * it with an unambiguous `wip(checkpoint):` prefix so the fixer inherits the
 * completed baseline.
 *
 * These tests use a real git repo (so git add / commit actually run) and mock
 * only the non-git collaborators (DB, queue, coder subprocess).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

// `runAgent`'s preflight replays the task branch onto the integration tip
// before the coder runs. It resolves the integration branch against the REAL
// repo root (`repoRoot()`), which is meaningless for the standalone temp repos
// these tests build — every run aborted with a rebase conflict before reaching
// the coder-exit handler under test. Worktree currency has its own cover in
// `core/lib/git/__tests__/worktree-integration-currency.test.ts`.
//
// `restoreWorktreeIfMissing` is also stubbed: since c31edf02 it calls
// `provisionWorktreeDeps`, which creates an `orchestrator/node_modules` symlink
// inside the temp repo. That symlink shows up as a dirty path in `git status`
// and contaminates the wip(checkpoint) commit test assertions.
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

// Use a plain factory (no importOriginal) to avoid triggering PGlite
// initialization that state-client.ts chains into. importOriginal here would
// eagerly open the DB and race against lessons-injection.test.ts's PGlite
// instance when both test files run in parallel.
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

/** Build a minimal MarsCtx stub that routes worktree / store fields. */
function makeCtx(taskId: string, store: object) {
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
      traceStore: null,
      onPid: vi.fn(),
    },
    currentStep: null,
    emit: vi.fn(),
    step: vi.fn(),
  } as never
}

/** Minimal store stub — getTask falls through to null so domains degrade cleanly. */
function makeStore() {
  return {
    getTask: vi.fn().mockResolvedValue(null),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    batch: vi.fn().mockResolvedValue([]),
  }
}

/** Simulate a killed coder: non-zero exit, no quota rejection, dirty stderr. */
function killedCoderResult(exitCode = 1) {
  return {
    exitCode,
    stderr: `coder process killed (signal)`,
    stdout: '',
    sessionId: null,
    conversation: [],
    quotaRejected: null,
  }
}

/**
 * Simulate a coder killed by the context-budget watchdog: the exit code and
 * the stderr phrase `classifyCoderExit` keys the context-exhausted branch on.
 */
function contextExhaustedCoderResult() {
  return {
    exitCode: 138,
    stderr: 'context budget exhausted (maxContextTokens)',
    stdout: '',
    sessionId: null,
    conversation: [],
    quotaRejected: null,
  }
}

/** Initialize a temp git repo, return its path. */
function initRepo(): string {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-checkpoint-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README'), 'hello\n')
  execFileSync('git', ['add', 'README'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['checkout', '-q', '-b', 'task/test-id', 'main'], { cwd: repo })
  return repo
}

/** Read git log subjects (newest first) from a repo. */
function gitLogSubjects(repo: string): string[] {
  return execFileSync('git', ['log', '--format=%s', 'main..HEAD'], { cwd: repo })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('coder-exit checkpoint — dirty worktree', () => {
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
    mockRestoreWorktreeIfMissing.mockResolvedValue('present')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('creates a wip(checkpoint): commit when coder exits non-zero with uncommitted work', async () => {
    // Write files to the worktree BEFORE the coder "runs" — simulating work
    // done mid-implementation before the watchdog killed the process.
    writeFileSync(resolve(repo, 'src.ts'), 'export const x = 1\n')
    writeFileSync(resolve(repo, 'test.ts'), 'import { x } from "./src"\n')

    mockRunWorkerWithSpan.mockResolvedValue(killedCoderResult(1))

    const ctx = makeCtx('test-id', makeStore())
    const worktreeOpts = { worktree: { path: repo, branch: 'task/test-id' } }

    await expect(runAgent(ctx, worktreeOpts)).rejects.toBeInstanceOf(WorkflowTerminalError)

    // The repo should now have a wip(checkpoint): commit ahead of main.
    const subjects = gitLogSubjects(repo)
    expect(subjects).toHaveLength(1)
    expect(subjects[0]).toMatch(/^wip\(checkpoint\):/)
  })

  it('checkpoint commit message includes exit code and file count', async () => {
    writeFileSync(resolve(repo, 'feature.ts'), 'export const done = true\n')

    mockRunWorkerWithSpan.mockResolvedValue(killedCoderResult(2))

    const ctx = makeCtx('test-id', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const subjects = gitLogSubjects(repo)
    expect(subjects[0]).toContain('exit 2')
    expect(subjects[0]).toContain('1 uncommitted path(s)')
    // Unambiguous non-merge marker.
    expect(subjects[0]).toContain('do not merge as-is')
  })

  it('statusOutput reports the checkpoint — not "may be empty"', async () => {
    writeFileSync(resolve(repo, 'work.ts'), 'export const work = true\n')

    mockRunWorkerWithSpan.mockResolvedValue(killedCoderResult(1))

    const ctx = makeCtx('test-id', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    expect(mockHandleTaskFailureWithFixTask).toHaveBeenCalledTimes(1)
    const call = mockHandleTaskFailureWithFixTask.mock.calls[0][0] as {
      recipeContext: { statusOutput: string }
    }
    const statusOutput = call.recipeContext.statusOutput
    expect(statusOutput).not.toContain('may be empty')
    expect(statusOutput).toContain('wip(checkpoint)')
    expect(statusOutput).toContain('task/test-id')
  })
})

describe('coder-exit checkpoint — clean worktree', () => {
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
    mockRestoreWorktreeIfMissing.mockResolvedValue('present')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('does NOT create a checkpoint commit when the worktree is already clean', async () => {
    // No files written — worktree is clean.
    mockRunWorkerWithSpan.mockResolvedValue(killedCoderResult(1))

    const ctx = makeCtx('test-id', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    // No commits ahead of main — no checkpoint was created.
    const subjects = gitLogSubjects(repo)
    expect(subjects).toHaveLength(0)
  })

  it('statusOutput reports clean-at-exit when worktree has no uncommitted work', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(killedCoderResult(1))

    const ctx = makeCtx('test-id', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    expect(mockHandleTaskFailureWithFixTask).toHaveBeenCalledTimes(1)
    const call = mockHandleTaskFailureWithFixTask.mock.calls[0][0] as {
      recipeContext: { statusOutput: string }
    }
    const statusOutput = call.recipeContext.statusOutput
    expect(statusOutput).not.toContain('may be empty')
    expect(statusOutput).toContain('clean at exit')
  })
})

/**
 * Context exhaustion used to be the one code-phase failure that reported
 * nothing about the worktree: the entire stored `failure_reason` was the bare
 * string `context-exhausted`. It is also the failure mode MOST likely to leave
 * substantial uncommitted work, because the coder was mid-task rather than
 * bailing — mars-70dc2672 failed this way holding 145 uncommitted lines across
 * three files, and survived only because an operator ran `git status` by hand
 * before choosing between `continue` and `restart`.
 */
describe('coder-exit context-exhausted — worktree state is reported', () => {
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
    mockRestoreWorktreeIfMissing.mockResolvedValue('present')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('records the dirty path count on the task error, matching coder-exit wording', async () => {
    writeFileSync(resolve(repo, 'checkpoint.ts'), 'export const a = 1\n')
    writeFileSync(resolve(repo, 'coder-exit.ts'), 'export const b = 2\n')
    writeFileSync(resolve(repo, 'merge.ts'), 'export const c = 3\n')

    mockRunWorkerWithSpan.mockResolvedValue(contextExhaustedCoderResult())

    const ctx = makeCtx('test-id', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const failedWrite = mockUpdateTask.mock.calls
      .map((call) => call[1] as { status?: string; error?: string })
      .find((patch) => patch.status === 'failed')
    expect(failedWrite?.error).toContain('context-exhausted')
    expect(failedWrite?.error).toContain('worktree had 3 uncommitted path(s)')
  })

  it('preserves the uncommitted work as a wip(checkpoint) commit at failure time', async () => {
    writeFileSync(resolve(repo, 'work.ts'), 'export const work = true\n')

    mockRunWorkerWithSpan.mockResolvedValue(contextExhaustedCoderResult())

    const ctx = makeCtx('test-id', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    // The whole point of checkpointing here rather than in `mars continue`:
    // the work is durable BEFORE the operator picks a verb, so reaching for
    // the destructive one first no longer loses it.
    const subjects = gitLogSubjects(repo)
    expect(subjects).toHaveLength(1)
    expect(subjects[0]).toMatch(/^wip\(checkpoint\):/)
    expect(subjects[0]).toContain('1 uncommitted path(s)')
  })

  it('records clean-at-exit when the worktree holds nothing, matching coder-exit wording', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(contextExhaustedCoderResult())

    const ctx = makeCtx('test-id', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-id' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const failedWrite = mockUpdateTask.mock.calls
      .map((call) => call[1] as { status?: string; error?: string })
      .find((patch) => patch.status === 'failed')
    expect(failedWrite?.error).toContain('worktree was clean at exit')

    expect(gitLogSubjects(repo)).toHaveLength(0)

    const call = mockHandleTaskFailureWithFixTask.mock.calls[0][0] as {
      recipeContext: { statusOutput: string }
    }
    expect(call.recipeContext.statusOutput).toContain('clean at exit')
  })
})
