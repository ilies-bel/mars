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
  mockRaiseActionQueueItem,
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
}))

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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-autocommit-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README'), 'hello\n')
  execFileSync('git', ['add', 'README'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['checkout', '-q', '-b', 'task/test-auto', 'main'], { cwd: repo })
  return repo
}

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

describe('auto-commit fast path for coder-left-uncommitted', () => {
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
  })

  afterEach(() => {
    mockRunWorkerWithSpan.mockReset()
    rmSync(repo, { recursive: true, force: true })
  })

  it('auto-commits when coder exits cleanly with uncommitted work', async () => {
    writeFileSync(resolve(repo, 'feature.ts'), 'export const x = 1\n')

    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())

    const ctx = makeCtx('test-auto', makeStore())
    const result = await runAgent(ctx, {
      worktree: { path: repo, branch: 'task/test-auto' },
    })

    expect(result).toHaveProperty('sessionId', 'sess-1')

    const subjects = gitLogSubjects(repo)
    expect(subjects).toHaveLength(1)
    expect(subjects[0]).toMatch(/^chore\(auto-commit\):/)
    expect(subjects[0]).toContain('1 path(s)')

    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
  })

  it('gives the coder one corrective commit turn before the auto-commit net', async () => {
    writeFileSync(resolve(repo, 'feature.ts'), 'export const x = 1\n')
    mockRunWorkerWithSpan
      .mockResolvedValueOnce(cleanCoderResult())
      .mockImplementationOnce(async () => {
        execFileSync('git', ['add', '-A'], { cwd: repo })
        execFileSync('git', ['commit', '-q', '-m', 'feat: coder committed on correction'], { cwd: repo })
        return cleanCoderResult()
      })

    await runAgent(makeCtx('test-auto', makeStore()), {
      worktree: { path: repo, branch: 'task/test-auto' },
    })

    expect(gitLogSubjects(repo)).toEqual(['feat: coder committed on correction'])
  })

  it('auto-commit message includes the file count', async () => {
    writeFileSync(resolve(repo, 'a.ts'), 'export const a = 1\n')
    writeFileSync(resolve(repo, 'b.ts'), 'export const b = 2\n')
    writeFileSync(resolve(repo, 'c.ts'), 'export const c = 3\n')

    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())

    const ctx = makeCtx('test-auto', makeStore())
    await runAgent(ctx, {
      worktree: { path: repo, branch: 'task/test-auto' },
    })

    const subjects = gitLogSubjects(repo)
    expect(subjects[0]).toContain('3 path(s)')
  })

  it('does not spawn fix-task on successful auto-commit', async () => {
    writeFileSync(resolve(repo, 'work.ts'), 'export const w = true\n')

    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())

    const ctx = makeCtx('test-auto', makeStore())
    await runAgent(ctx, {
      worktree: { path: repo, branch: 'task/test-auto' },
    })

    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
  })

  it('coder that already committed is the happy path — no auto-commit needed', async () => {
    writeFileSync(resolve(repo, 'done.ts'), 'export const done = true\n')
    execFileSync('git', ['add', 'done.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'feat: done'], { cwd: repo })

    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())

    const ctx = makeCtx('test-auto', makeStore())
    const result = await runAgent(ctx, {
      worktree: { path: repo, branch: 'task/test-auto' },
    })

    expect(result).toHaveProperty('sessionId', 'sess-1')

    const subjects = gitLogSubjects(repo)
    expect(subjects).toHaveLength(1)
    expect(subjects[0]).toBe('feat: done')
  })

  it('records provider, commit source, and metered context for the task', async () => {
    writeFileSync(resolve(repo, 'done.ts'), 'export const done = true\n')
    execFileSync('git', ['add', 'done.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'feat: done'], { cwd: repo })
    mockRunWorkerWithSpan.mockResolvedValue({
      ...cleanCoderResult(),
      conversation: [{ type: 'result', usage: { input_tokens: 1234 } }],
    })
    const traceStore = { record: vi.fn().mockResolvedValue(undefined) }

    await runAgent(makeCtx('test-auto', makeStore(), traceStore), {
      worktree: { path: repo, branch: 'task/test-auto' },
    })

    expect(traceStore.record).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'post-coder-commit',
      payload: expect.objectContaining({
        provider: expect.any(String),
        commitSource: 'self',
        contextTokens: 1234,
      }),
    }))
  })
})

describe('auto-commit failure path', () => {
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
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises action-queue item and throws when auto-commit fails (pre-commit hook rejects)', async () => {
    // Write real uncommitted work so detectPostCoderState sees dirty files
    writeFileSync(resolve(repo, 'feature.ts'), 'export const x = 1\n')

    // Install a pre-commit hook that always rejects
    const hooksDir = resolve(repo, '.git', 'hooks')
    execFileSync('mkdir', ['-p', hooksDir])
    writeFileSync(resolve(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())

    const ctx = makeCtx('test-auto', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-auto' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-auto',
      expect.objectContaining({
        status: 'failed',
        failureReasonCode: 'orchestration:coder-left-uncommitted-unfixable',
      }),
      expect.anything(),
    )

    expect(mockRaiseActionQueueItem).toHaveBeenCalledTimes(1)
    expect(mockRaiseActionQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'failed',
        raisedBy: 'workflow:code:auto-commit-failed',
        signature: 'coder-uncommitted:test-auto',
      }),
    )

    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
  })
})
