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

describe('coder commit contract (code step post-condition)', () => {
  let repo: string

  const commitFeature = (): void => {
    writeFileSync(resolve(repo, 'feature.ts'), 'export const x = 1\n')
    execFileSync('git', ['add', 'feature.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'feat: committed slice'], { cwd: repo })
  }

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
    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('fails the code step when the coder commits but leaves a tracked file modified', async () => {
    // The fix-30ac0aaa shape: real commits AND leftover uncommitted edits.
    // Used to be classified `clean-with-commits`, sail through verify, and
    // blow up at the rebase as `merge/unclassified`.
    commitFeature()
    writeFileSync(resolve(repo, 'README'), 'edited but never committed\n')

    const ctx = makeCtx('test-auto', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-auto' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-auto',
      expect.objectContaining({
        status: 'failed',
        failedPhase: 'code',
        failureReason: 'code:commit-contract',
        failureSignature: 'code:commit-contract/uncommitted-changes',
        failureReasonCode: 'code:commit-contract/uncommitted-changes',
      }),
      expect.anything(),
    )

    // The failure names the offending file, and the step it blames is `code`.
    const [failureArgs] = mockHandleTaskFailureWithFixTask.mock.calls.at(-1) ?? []
    expect(failureArgs).toMatchObject({
      taskId: 'test-auto',
      failingStep: 'code:commit-contract',
    })
    expect(failureArgs.errorOutput).toContain('README')

    // Nothing was swept into a commit behind the coder's back.
    expect(gitLogSubjects(repo)).toEqual(['feat: committed slice'])
  })

  it('fails the code step when the only leftover dirt is untracked', async () => {
    commitFeature()
    writeFileSync(resolve(repo, 'scratch.ts'), 'export const scratch = true\n')

    const ctx = makeCtx('test-auto', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-auto' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    const [failureArgs] = mockHandleTaskFailureWithFixTask.mock.calls.at(-1) ?? []
    expect(failureArgs.failingStep).toBe('code:commit-contract')
    expect(failureArgs.errorOutput).toContain('scratch.ts')
  })

  it('passes a clean worktree that is ahead of the integration branch', async () => {
    commitFeature()

    const ctx = makeCtx('test-auto', makeStore())
    const result = await runAgent(ctx, {
      worktree: { path: repo, branch: 'task/test-auto' },
    })

    expect(result).toHaveProperty('sessionId', 'sess-1')
    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
  })

  it('measures the branch against the INTEGRATION_BRANCH override, not main', async () => {
    // `INTEGRATION_BRANCH` arrives as the workflow input's `integrationBranch`
    // (startDaemon reads the env var and threads it through), so the same
    // worktree must classify differently depending on the merge target.
    commitFeature()
    // The release line already contains the commit; `main` does not.
    execFileSync('git', ['branch', 'release/next', 'task/test-auto'], { cwd: repo })
    writeFileSync(resolve(repo, 'README'), 'edited but never committed\n')

    const ctx = makeCtx('test-auto', makeStore())
    // Against the override the branch is 0 commits ahead, so this is the
    // pre-existing dirty-no-commits shape and the auto-commit path handles it.
    await runAgent(ctx, {
      worktree: { path: repo, branch: 'task/test-auto' },
      integrationBranch: 'release/next',
    })
    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()

    // Against `main` the very same tree is 1 commit ahead — the contract gate
    // owns it. Had the comparison been hardcoded to `main`, the run above
    // would have taken this branch instead.
    execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: repo })
    execFileSync('git', ['reset', '-q', '--hard', 'release/next'], { cwd: repo })
    writeFileSync(resolve(repo, 'README'), 'edited but never committed\n')
    vi.clearAllMocks()
    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())
    mockUpdateTask.mockResolvedValue(undefined)
    mockResolveOriginIdForTask.mockImplementation(async (id: string) => id)
    mockCleanWorktreeIfNoCommitsAhead.mockResolvedValue({
      cleaned: false,
      reason: 'skipped for test',
      output: '',
    })
    mockFetchLessonsForTask.mockResolvedValue([])
    mockListMergedWorkers.mockReturnValue([])
    mockRecordSignals.mockResolvedValue(undefined)

    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-auto' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)
    const [failureArgs] = mockHandleTaskFailureWithFixTask.mock.calls.at(-1) ?? []
    expect(failureArgs.failingStep).toBe('code:commit-contract')
    expect(failureArgs.errorOutput).toContain('integration branch: main')
  })
})
