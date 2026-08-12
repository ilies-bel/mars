/**
 * Tests for per-run coder-failure artifact files.
 *
 * When a coder process exits non-zero the orchestrator writes a bounded
 * head+tail of both stdout and stderr into
 * <worktreePath>/.mars/coder-failures/<sessionKey>.log so the failure can be
 * diagnosed later (via `mars diagnose` or direct inspection) without having to
 * reconstruct from the truncated `tasks.error` string.
 *
 * Additional assertions cover:
 * - Termination-cause classification (natural exit, SIGKILL, SIGTERM, timeout)
 * - Zero-message labelling (coder never reached the provider)
 * - Artifact path referenced in `tasks.error`
 * - Tail capture when streams exceed the 2 kB head budget
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { WorkflowTerminalError } from '../../../core/lib/workflow-terminal-error'

// ---------------------------------------------------------------------------
// Hoisted mocks  (identical surface to coder-exit-checkpoint.test.ts)
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
}))

vi.mock('../../../core/lib/git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/worktree')>()
  return { ...orig, syncWorktreeToIntegration: mockSyncWorktreeToIntegration }
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

// Import runAgent AFTER vi.mock() hoisting is complete — same pattern as
// coder-exit-checkpoint.test.ts. A dynamic import inside beforeEach would
// see a stale (pre-mock) module cache and ignore the mocks above.
const { runAgent } = await import('../index')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeStore() {
  return {
    getTask: vi.fn().mockResolvedValue(null),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    batch: vi.fn().mockResolvedValue([]),
  }
}

/**
 * Build a coder result stub.
 * `conversation` defaults to a single stub entry so messageCount > 0 unless
 * callers pass an empty array.
 */
function coderResult(overrides: {
  exitCode?: number
  stdout?: string
  stderr?: string
  conversation?: unknown[]
}) {
  return {
    exitCode: overrides.exitCode ?? 1,
    stdout: overrides.stdout ?? 'some stdout output',
    stderr: overrides.stderr ?? 'some stderr output',
    sessionId: null,
    conversation: overrides.conversation ?? [{ type: 'assistant', content: 'hi' }],
    quotaRejected: null,
  }
}

/** Initialize a temp git repo with `.mars/` gitignored so artifact files
 *  never appear as untracked to `detectPostCoderState`. Returns the repo path. */
function initRepo(): string {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-artifact-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  // Ignore the .mars/ dir so artifact files never show up in `git status`.
  writeFileSync(resolve(repo, '.gitignore'), '.mars/\n')
  writeFileSync(resolve(repo, 'README'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['checkout', '-q', '-b', 'task/test-id', 'main'], { cwd: repo })
  return repo
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('coder-exit artifact', () => {
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
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('writes the artifact file into <worktreePath>/.mars/coder-failures/', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(
      coderResult({ exitCode: 1, stdout: 'STDOUT_DATA', stderr: 'STDERR_DATA' }),
    )
    await expect(
      runAgent(makeCtx('test-id', makeStore()), {
        worktree: { path: repo, branch: 'task/test-id' },
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    // A .log file must exist under .mars/coder-failures/
    const { readdirSync } = await import('node:fs')
    const dir = resolve(repo, '.mars', 'coder-failures')
    expect(existsSync(dir)).toBe(true)
    const files = readdirSync(dir)
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/\.log$/)
  })

  it('artifact content includes the stdout head', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(
      coderResult({ exitCode: 1, stdout: 'MY_STDOUT_CONTENT', stderr: '' }),
    )
    await expect(
      runAgent(makeCtx('test-id', makeStore()), {
        worktree: { path: repo, branch: 'task/test-id' },
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const dir = resolve(repo, '.mars', 'coder-failures')
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(dir)
    const content = readFileSync(resolve(dir, files[0]), 'utf8')
    expect(content).toContain('MY_STDOUT_CONTENT')
  })

  it('artifact content includes the stderr head', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(
      coderResult({ exitCode: 1, stdout: '', stderr: 'MY_STDERR_CONTENT' }),
    )
    await expect(
      runAgent(makeCtx('test-id', makeStore()), {
        worktree: { path: repo, branch: 'task/test-id' },
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const dir = resolve(repo, '.mars', 'coder-failures')
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(dir)
    const content = readFileSync(resolve(dir, files[0]), 'utf8')
    expect(content).toContain('MY_STDERR_CONTENT')
  })

  it('artifact records termination-cause as natural-exit-or-unclassified for exit 1', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(coderResult({ exitCode: 1 }))
    await expect(
      runAgent(makeCtx('test-id', makeStore()), {
        worktree: { path: repo, branch: 'task/test-id' },
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const dir = resolve(repo, '.mars', 'coder-failures')
    const { readdirSync } = await import('node:fs')
    const content = readFileSync(resolve(dir, readdirSync(dir)[0]), 'utf8')
    expect(content).toContain('termination-cause: natural-exit-or-unclassified (exit 1)')
  })

  it('artifact records termination-cause killed-by-SIGKILL for exit 137', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(coderResult({ exitCode: 137 }))
    await expect(
      runAgent(makeCtx('test-id', makeStore()), {
        worktree: { path: repo, branch: 'task/test-id' },
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const dir = resolve(repo, '.mars', 'coder-failures')
    const { readdirSync } = await import('node:fs')
    const content = readFileSync(resolve(dir, readdirSync(dir)[0]), 'utf8')
    expect(content).toContain('termination-cause: killed-by-SIGKILL')
  })

  it('artifact records termination-cause killed-by-SIGTERM for exit 143', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(coderResult({ exitCode: 143 }))
    await expect(
      runAgent(makeCtx('test-id', makeStore()), {
        worktree: { path: repo, branch: 'task/test-id' },
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const dir = resolve(repo, '.mars', 'coder-failures')
    const { readdirSync } = await import('node:fs')
    const content = readFileSync(resolve(dir, readdirSync(dir)[0]), 'utf8')
    expect(content).toContain('termination-cause: killed-by-SIGTERM')
  })

  it('artifact records termination-cause timed-out for exit 124', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(coderResult({ exitCode: 124 }))
    await expect(
      runAgent(makeCtx('test-id', makeStore()), {
        worktree: { path: repo, branch: 'task/test-id' },
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const dir = resolve(repo, '.mars', 'coder-failures')
    const { readdirSync } = await import('node:fs')
    const content = readFileSync(resolve(dir, readdirSync(dir)[0]), 'utf8')
    expect(content).toContain('termination-cause: timed-out')
  })

  it('artifact records messages-exchanged: 0 when conversation is empty', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(
      coderResult({ exitCode: 1, conversation: [] }),
    )
    await expect(
      runAgent(makeCtx('test-id', makeStore()), {
        worktree: { path: repo, branch: 'task/test-id' },
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const dir = resolve(repo, '.mars', 'coder-failures')
    const { readdirSync } = await import('node:fs')
    const content = readFileSync(resolve(dir, readdirSync(dir)[0]), 'utf8')
    expect(content).toContain('messages-exchanged: 0')
  })

  it('tasks.error includes the artifact path', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(coderResult({ exitCode: 1 }))
    await expect(
      runAgent(makeCtx('test-id', makeStore()), {
        worktree: { path: repo, branch: 'task/test-id' },
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    expect(mockUpdateTask).toHaveBeenCalled()
    const [, patch] = mockUpdateTask.mock.calls[0] as [string, { error?: string }]
    expect(patch.error).toContain('Diagnostic artifact:')
    expect(patch.error).toContain('.mars/coder-failures/')
    expect(patch.error).toContain('.log')
  })

  it('tasks.error labels zero-message runs', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(
      coderResult({ exitCode: 1, conversation: [] }),
    )
    await expect(
      runAgent(makeCtx('test-id', makeStore()), {
        worktree: { path: repo, branch: 'task/test-id' },
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    expect(mockUpdateTask).toHaveBeenCalled()
    const [, patch] = mockUpdateTask.mock.calls[0] as [string, { error?: string }]
    expect(patch.error).toContain('ZERO MESSAGES EXCHANGED WITH PROVIDER')
  })

  it('artifact captures the tail when stdout exceeds 2000 chars', async () => {
    const head = 'A'.repeat(2000)
    const tail = 'Z'.repeat(2000)
    const longStdout = head + 'M'.repeat(500) + tail
    mockRunWorkerWithSpan.mockResolvedValue(
      coderResult({ exitCode: 1, stdout: longStdout, stderr: '' }),
    )
    await expect(
      runAgent(makeCtx('test-id', makeStore()), {
        worktree: { path: repo, branch: 'task/test-id' },
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const dir = resolve(repo, '.mars', 'coder-failures')
    const { readdirSync } = await import('node:fs')
    const content = readFileSync(resolve(dir, readdirSync(dir)[0]), 'utf8')
    // Head: starts with 2000 A's
    expect(content).toContain('A'.repeat(100))
    // Tail section present
    expect(content).toContain('stdout tail')
    // Tail: ends with 2000 Z's
    expect(content).toContain('Z'.repeat(100))
  })
})
