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
  mockRaiseActionQueueItem: vi.fn().mockResolvedValue(undefined),
  mockSyncWorktreeToIntegration: vi.fn().mockResolvedValue({ kind: 'already-current' }),
}))

// `runAgent`'s preflight replays the task branch onto the integration tip
// before the coder runs. It resolves the integration branch in the REAL repo
// root (`repoRoot()`), which is meaningless for the standalone temp repos these
// tests build, so it is stubbed to the already-current no-op. Worktree currency
// has its own cover in `core/lib/git/__tests__/worktree-integration-currency.test.ts`;
// this file is about the post-coder commit contract.
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

  it('gives a resumed coder the verify failure that needs fixing', async () => {
    mockRunWorkerWithSpan.mockResolvedValue(cleanCoderResult())
    const ctx = makeCtx('test-auto', makeStore()) as {
      input: Record<string, unknown>
    }
    ctx.input = {
      ...ctx.input,
      resumeFromPriorAttempt: true,
      verifyFailureOutput: 'typecheck: Property priority is missing',
    }

    await runAgent(ctx as never, {
      worktree: { path: repo, branch: 'task/test-auto' },
    })

    expect(mockRunWorkerWithSpan).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('Property priority is missing'),
    }))
    expect(mockRunWorkerWithSpan).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('Resume prior work'),
    }))
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
        // The default provider (Codex) reports CUMULATIVE spend, not
        // per-request context occupancy, so `buildContextTokenSignals` emits
        // `cumulativeTokens` — never a fabricated `contextTokens`.
        cumulativeTokens: 1234,
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

  it('recovers — does NOT fail — when the coder commits then leaves a tracked file modified', async () => {
    // The fix-30ac0aaa / fix-ec2f6c04 shape: the coder committed once, kept
    // working, and left more paths dirty. This used to be a terminal
    // `code:commit-contract/uncommitted-changes` failure — the single largest
    // source of task failures on the live queue, and what tripped the
    // signature-storm circuit breaker. It now takes the same corrective-turn +
    // auto-commit escalation as a coder that committed nothing.
    commitFeature()
    writeFileSync(resolve(repo, 'README'), 'edited but never committed\n')

    const ctx = makeCtx('test-auto', makeStore())
    const result = await runAgent(ctx, {
      worktree: { path: repo, branch: 'task/test-auto' },
    })

    expect(result).toHaveProperty('sessionId', 'sess-1')
    expect(mockUpdateTask).not.toHaveBeenCalledWith(
      'test-auto',
      expect.objectContaining({ status: 'failed' }),
      expect.anything(),
    )
    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()

    // The coder's own commit is untouched and the leftover path rides on a
    // clearly-attributed orchestrator commit on top of it.
    const subjects = gitLogSubjects(repo)
    expect(subjects).toHaveLength(2)
    expect(subjects[1]).toBe('feat: committed slice')
    expect(subjects[0]).toMatch(/^chore\(auto-commit\): task test-auto — /)
    expect(subjects[0]).toContain('1 path(s)')
    // The worktree is clean, so nothing is left to block the merge rebase.
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString().trim(),
    ).toBe('')
  })

  it('gives the coder a corrective turn first and keeps its commit when it takes it', async () => {
    commitFeature()
    writeFileSync(resolve(repo, 'README'), 'edited but never committed\n')
    mockRunWorkerWithSpan
      .mockReset()
      .mockResolvedValueOnce(cleanCoderResult())
      .mockImplementationOnce(async () => {
        execFileSync('git', ['add', '-A'], { cwd: repo })
        execFileSync('git', ['commit', '-q', '-m', 'chore: commit the leftovers'], {
          cwd: repo,
        })
        return cleanCoderResult()
      })

    await runAgent(makeCtx('test-auto', makeStore()), {
      worktree: { path: repo, branch: 'task/test-auto' },
    })

    // No auto-commit was needed: the coder took authorship on the correction.
    expect(gitLogSubjects(repo)).toEqual([
      'chore: commit the leftovers',
      'feat: committed slice',
    ])
  })

  it('recovers when the coder commits and the only leftover dirt is untracked', async () => {
    commitFeature()
    writeFileSync(resolve(repo, 'scratch.ts'), 'export const scratch = true\n')

    const ctx = makeCtx('test-auto', makeStore())
    await runAgent(ctx, { worktree: { path: repo, branch: 'task/test-auto' } })

    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
    expect(gitLogSubjects(repo)[0]).toMatch(/^chore\(auto-commit\):/)
    expect(
      execFileSync('git', ['log', '-1', '--format=%H', '--', 'scratch.ts'], {
        cwd: repo,
      })
        .toString()
        .trim(),
    ).not.toBe('')
  })

  it('still fails terminally when the coder committed and the auto-commit net is refused', async () => {
    // The genuinely terminal case survives: nothing landed, nothing can land
    // without an operator. It carries the ONE registered signature so the
    // action queue names it and self-heal finds its recipe.
    commitFeature()
    writeFileSync(resolve(repo, 'README'), 'edited but never committed\n')
    const hooksDir = resolve(repo, '.git', 'hooks')
    execFileSync('mkdir', ['-p', hooksDir])
    writeFileSync(resolve(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    const ctx = makeCtx('test-auto', makeStore())
    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-auto' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)

    expect(mockUpdateTask).toHaveBeenCalledWith(
      'test-auto',
      expect.objectContaining({
        status: 'failed',
        failedPhase: 'code',
        failureReason: 'code',
        failureSignature: 'code/uncommitted-changes',
        failureReasonCode: 'orchestration:coder-left-uncommitted-unfixable',
      }),
      expect.anything(),
    )
    expect(mockRaiseActionQueueItem).toHaveBeenCalledTimes(1)
    // The coder's own commit is untouched; nothing was swept in.
    expect(gitLogSubjects(repo)).toEqual(['feat: committed slice'])
  })

  it('auto-commits a tracked dotenv file without raising an action-queue item', async () => {
    commitFeature()
    writeFileSync(resolve(repo, '.env'), 'API_KEY=super-secret\n')

    const ctx = makeCtx('test-auto', makeStore())
    const result = await runAgent(ctx, {
      worktree: { path: repo, branch: 'task/test-auto' },
    })

    expect(result).toHaveProperty('sessionId', 'sess-1')
    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
    expect(
      execFileSync('git', ['log', '--all', '--format=%H', '--', '.env'], { cwd: repo })
        .toString()
        .trim(),
    ).not.toBe('')
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
    // worktree must be measured against the merge target that was passed in.
    // Asserted through the terminal path (a rejecting pre-commit hook), which
    // is the only place the resolved branch and commit count are reported.
    commitFeature()
    // The release line already contains the commit; `main` does not.
    execFileSync('git', ['branch', 'release/next', 'task/test-auto'], { cwd: repo })
    writeFileSync(resolve(repo, 'README'), 'edited but never committed\n')
    const hooksDir = resolve(repo, '.git', 'hooks')
    execFileSync('mkdir', ['-p', hooksDir])
    writeFileSync(resolve(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    const ctx = makeCtx('test-auto', makeStore())
    // Against the override the branch is 0 commits ahead of `release/next`.
    await expect(
      runAgent(ctx, {
        worktree: { path: repo, branch: 'task/test-auto' },
        integrationBranch: 'release/next',
      }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)
    let update = mockUpdateTask.mock.calls.at(-1)?.[1] as { error: string }
    expect(mockUpdateTask.mock.calls.at(-1)?.[0]).toBe('test-auto')
    expect(update.error).toContain('integration branch: release/next')
    expect(update.error).toContain('committed 0 commit(s)')

    // Against `main` the very same tree is 1 commit ahead. Had the comparison
    // been hardcoded to `main`, the run above would have reported 1 too.
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
    mockRaiseActionQueueItem.mockResolvedValue(undefined)

    await expect(
      runAgent(ctx, { worktree: { path: repo, branch: 'task/test-auto' } }),
    ).rejects.toBeInstanceOf(WorkflowTerminalError)
    update = mockUpdateTask.mock.calls.at(-1)?.[1] as { error: string }
    expect(update.error).toContain('integration branch: main')
    expect(update.error).toContain('committed 1 commit(s)')
  })
})
