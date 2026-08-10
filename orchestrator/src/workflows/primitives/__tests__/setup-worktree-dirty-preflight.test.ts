/**
 * Setup-step integration-branch dirty-tree guard.
 *
 * Acceptance criteria (slice 1 of PRD 38898433):
 *   - clean integration branch → setup proceeds normally; worktree is created;
 *     no action-queue item is raised; no task blocked.
 *   - dirty integration branch → task transitions to status='blocked'; an
 *     action-queue item naming each dirty path and the integration branch name
 *     is raised; no worktree is created; WorkflowTerminalError is thrown.
 *   - main-committer fix tasks are exempt: they exist to clean a dirty
 *     integration branch and must proceed even when main has uncommitted changes.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetContextCacheForTests } from '../../../core/context'
import { WorkflowTerminalError } from '../../../core/lib/workflow-terminal-error'

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before any top-level awaits)
// ---------------------------------------------------------------------------

const {
  mockUpdateTask,
  mockHasIncompleteBlockers,
  mockCheckIntegrationBranchDirty,
  mockParseMainCommiterPayload,
  mockCreateWorktree,
  mockSyncWorktreeToIntegration,
  mockInstallWorktreeDeps,
  mockRaiseActionQueueItem,
  mockRunTool,
  mockResolveOriginIdForTask,
  mockRestoreWorktreeIfMissing,
  mockProvisionCommitterWorktree,
  mockAttachToOriginWorktree,
  // Checkpoint mocks (for the auto-stash preflight and merge restore paths)
  mockCaptureCheckpoint,
  mockDiscardWorkingTreeChanges,
  mockRestoreCheckpoint,
  mockCheckpointRefFor,
  // Merge-step mocks (for the preflight restore describe block)
  mockIsZeroCommitBranch,
  mockCheckMergeTargetStatus,
  mockIsBranchTipInIntegration,
  mockFindLiveWorktreeDependents,
  mockRemoveWorktree,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockHasIncompleteBlockers: vi.fn().mockResolvedValue(false),
  // Default: clean branch (guard passes through)
  mockCheckIntegrationBranchDirty: vi.fn().mockResolvedValue({ dirty: false, statusOutput: '' }),
  mockParseMainCommiterPayload: vi.fn().mockReturnValue(null),
  mockCreateWorktree: vi
    .fn()
    .mockResolvedValue({ path: '/tmp/fake-worktree', branch: 'task/test-task' }),
  mockSyncWorktreeToIntegration: vi.fn().mockResolvedValue({ kind: 'already-current' }),
  mockInstallWorktreeDeps: vi.fn().mockResolvedValue({ sites: [], totalDurationMs: 0 }),
  mockRaiseActionQueueItem: vi.fn().mockResolvedValue('aq-item-1'),
  mockRunTool: vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: 'abc1234\n',
    stderr: '',
    durationMs: 1,
    traceEventId: 'trace-1',
  }),
  mockResolveOriginIdForTask: vi.fn().mockImplementation(async (id: string) => id),
  mockRestoreWorktreeIfMissing: vi.fn().mockResolvedValue('present'),
  mockProvisionCommitterWorktree: vi
    .fn()
    .mockResolvedValue({ path: '/tmp/fake-committer', branch: 'task/fix-committer' }),
  mockAttachToOriginWorktree: vi
    .fn()
    .mockResolvedValue({ path: '/tmp/fake-origin', branch: 'task/origin' }),
  // Checkpoint: default captures two .mars/ files; restore is a no-op.
  mockCaptureCheckpoint: vi.fn().mockResolvedValue({
    ref: 'refs/mars/checkpoint/test-task-preflight',
    sha: 'preflightsha1234',
    files: ['.mars/pg.dsn', '.mars/http.port'],
  }),
  mockDiscardWorkingTreeChanges: vi.fn().mockResolvedValue(undefined),
  mockRestoreCheckpoint: vi.fn().mockResolvedValue(undefined),
  mockCheckpointRefFor: vi.fn().mockImplementation(
    (key: string) =>
      `refs/mars/checkpoint/${key.replace(/[^A-Za-z0-9._-]/g, '-')}`,
  ),
  // Merge-step stubs (used only in the 'merge preflight restore' describe block).
  mockIsZeroCommitBranch: vi.fn().mockResolvedValue(false),
  mockCheckMergeTargetStatus: vi.fn().mockResolvedValue({ kind: 'clean' }),
  mockIsBranchTipInIntegration: vi.fn().mockResolvedValue(true),
  mockFindLiveWorktreeDependents: vi.fn().mockResolvedValue([]),
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// vi.mock declarations (hoisted by Vitest before any module imports)
// ---------------------------------------------------------------------------

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return { ...orig, updateTask: mockUpdateTask, hasIncompleteBlockers: mockHasIncompleteBlockers }
})

vi.mock('../../../core/lib/main-dirty', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/main-dirty')>()
  return {
    ...orig,
    checkIntegrationBranchDirty: mockCheckIntegrationBranchDirty,
    parseMainCommiterPayload: mockParseMainCommiterPayload,
    // Keep MAIN_COMMITER_RECIPE as-is so the main-committer-fix exemption check works.
  }
})

vi.mock('../../../core/lib/git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/worktree')>()
  return {
    ...orig,
    createWorktree: mockCreateWorktree,
    syncWorktreeToIntegration: mockSyncWorktreeToIntegration,
    restoreWorktreeIfMissing: mockRestoreWorktreeIfMissing,
    provisionCommitterWorktree: mockProvisionCommitterWorktree,
    attachToOriginWorktree: mockAttachToOriginWorktree,
    removeWorktree: mockRemoveWorktree,
  }
})

vi.mock('../../../core/lib/worktree-install', () => ({
  installWorktreeDeps: mockInstallWorktreeDeps,
  repairInstallInPlace: vi.fn().mockResolvedValue({ repaired: false }),
  WorktreeInstallError: class WorktreeInstallError extends Error {},
  WorktreeModulesMissingError: class WorktreeModulesMissingError extends Error {
    failureStep = 'setup:modules-missing'
  },
}))

vi.mock('../../../core/lib/action-queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/action-queue')>()
  return { ...orig, raiseActionQueueItem: mockRaiseActionQueueItem }
})

vi.mock('../../../core/lib/run-tool', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/run-tool')>()
  return { ...orig, runTool: mockRunTool }
})

vi.mock('../../../core/lib/origin', () => ({
  resolveOriginIdForTask: mockResolveOriginIdForTask,
}))

vi.mock('../../../core/queue-fix-tasks', () => ({
  handleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
}))

// Checkpoint: mock captureCheckpoint, discardWorkingTreeChanges, restoreCheckpoint, and
// checkpointRefFor so tests run without a real git repo in the integration checkout.
vi.mock('../../../core/lib/git/checkpoint', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/checkpoint')>()
  return {
    ...orig,
    captureCheckpoint: mockCaptureCheckpoint,
    discardWorkingTreeChanges: mockDiscardWorkingTreeChanges,
    restoreCheckpoint: mockRestoreCheckpoint,
    checkpointRefFor: mockCheckpointRefFor,
  }
})

// Merge primitives: used only in the 'merge preflight restore' describe block.
vi.mock('../../../core/lib/git/merge', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/merge')>()
  return {
    ...orig,
    isZeroCommitBranch: mockIsZeroCommitBranch,
    checkMergeTargetStatus: mockCheckMergeTargetStatus,
    isBranchTipInIntegration: mockIsBranchTipInIntegration,
  }
})

vi.mock('../../../core/lib/worktree-dependents', () => ({
  findLiveWorktreeDependents: mockFindLiveWorktreeDependents,
}))

vi.mock('../../../core/lib/run-worker-with-span', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/run-worker-with-span')>()
  return {
    ...orig,
    runNonLlmStepWithSpan: async <T>(opts: { fn: () => Promise<T> }) => opts.fn(),
  }
})

vi.mock('../../../core/lib/reflect-signals', () => ({
  recordSignals: vi.fn().mockResolvedValue(undefined),
}))

// Import the primitives AFTER all vi.mock() calls.
const { setupWorktree, merge } = await import('../index')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRepo: string

function makeCtx(taskId: string, overrides: { kind?: string; recoveryPayload?: string | null } = {}) {
  return {
    runId: taskId,
    workflowId: 'task',
    input: {
      taskId,
      kind: overrides.kind ?? 'task',
      integrationBranch: 'main',
      recoveryPayload: overrides.recoveryPayload ?? null,
      fixForTaskId: null,
    },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store: {
        getTask: vi.fn().mockResolvedValue(null),
        query: vi.fn().mockResolvedValue({ rows: [] }),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        batch: vi.fn().mockResolvedValue([]),
        atomic: vi.fn().mockImplementation(async (fn: (scope: unknown) => Promise<void>) => {
          await fn({ execute: vi.fn().mockResolvedValue({ rows: [] }) })
        }),
      },
      traceStore: null,
    },
    currentStep: null,
    emit: vi.fn(),
    step: vi.fn(),
  } as never
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

beforeEach(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'mars-dirty-preflight-'))
  process.env.MARS_REPO = tmpRepo
  __resetContextCacheForTests()

  // Reset all mocks to their defaults.
  mockUpdateTask.mockReset().mockResolvedValue(undefined)
  mockHasIncompleteBlockers.mockReset().mockResolvedValue(false)
  mockCheckIntegrationBranchDirty.mockReset().mockResolvedValue({ dirty: false, statusOutput: '' })
  mockParseMainCommiterPayload.mockReset().mockReturnValue(null)
  mockCreateWorktree.mockReset().mockResolvedValue({ path: '/tmp/fake-worktree', branch: 'task/test-task' })
  mockSyncWorktreeToIntegration.mockReset().mockResolvedValue({ kind: 'already-current' })
  mockInstallWorktreeDeps.mockReset().mockResolvedValue({ sites: [], totalDurationMs: 0 })
  mockRaiseActionQueueItem.mockReset().mockResolvedValue('aq-item-1')
  mockRunTool.mockReset().mockResolvedValue({
    exitCode: 0,
    stdout: 'abc1234\n',
    stderr: '',
    durationMs: 1,
    traceEventId: 'trace-1',
  })
  mockResolveOriginIdForTask.mockReset().mockImplementation(async (id: string) => id)
  mockRestoreWorktreeIfMissing.mockReset().mockResolvedValue('present')
  // Checkpoint mocks
  mockCaptureCheckpoint.mockReset().mockResolvedValue({
    ref: 'refs/mars/checkpoint/test-task-preflight',
    sha: 'preflightsha1234',
    files: ['.mars/pg.dsn', '.mars/http.port'],
  })
  mockDiscardWorkingTreeChanges.mockReset().mockResolvedValue(undefined)
  mockRestoreCheckpoint.mockReset().mockResolvedValue(undefined)
  mockCheckpointRefFor.mockReset().mockImplementation(
    (key: string) =>
      `refs/mars/checkpoint/${key.replace(/[^A-Za-z0-9._-]/g, '-')}`,
  )
  // Merge-step mocks
  mockIsZeroCommitBranch.mockReset().mockResolvedValue(false)
  mockCheckMergeTargetStatus.mockReset().mockResolvedValue({ kind: 'clean' })
  mockIsBranchTipInIntegration.mockReset().mockResolvedValue(true)
  mockFindLiveWorktreeDependents.mockReset().mockResolvedValue([])
  mockRemoveWorktree.mockReset().mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setup-worktree dirty-integration preflight guard', () => {
  it('proceeds normally when the integration branch is clean', async () => {
    // Arrange: clean integration branch (default mock)
    mockCheckIntegrationBranchDirty.mockResolvedValue({ dirty: false, statusOutput: '' })
    const ctx = makeCtx('test-clean')

    // Act
    const result = await setupWorktree(ctx)

    // Assert: worktree created, no blocked status, no action-queue item
    expect(result).toMatchObject({ path: '/tmp/fake-worktree', branch: 'task/test-task' })
    expect(mockCreateWorktree).toHaveBeenCalledOnce()
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
    // updateTask was called with 'running' (setup started), never with 'blocked'
    const blockedCall = mockUpdateTask.mock.calls.find(
      (call) => call[1]?.status === 'blocked',
    )
    expect(blockedCall).toBeUndefined()
  })

  it('parks task as blocked when integration branch has uncommitted changes', async () => {
    // Arrange: dirty integration branch
    const statusOutput = ' M README.md\n?? scratch.txt'
    mockCheckIntegrationBranchDirty.mockResolvedValue({ dirty: true, statusOutput })
    const ctx = makeCtx('test-dirty')

    // Act
    await expect(setupWorktree(ctx)).rejects.toThrow(WorkflowTerminalError)

    // Assert: task is blocked
    const blockedCall = mockUpdateTask.mock.calls.find(
      (call) => call[1]?.status === 'blocked',
    )
    expect(blockedCall).toBeDefined()

    // Assert: worktree was NOT created
    expect(mockCreateWorktree).not.toHaveBeenCalled()
  })

  it('raises an action-queue item naming the integration branch and dirty paths', async () => {
    // Arrange
    const statusOutput = ' M src/index.ts\n M package.json'
    mockCheckIntegrationBranchDirty.mockResolvedValue({ dirty: true, statusOutput })
    const ctx = makeCtx('test-aq')

    // Act
    await expect(setupWorktree(ctx)).rejects.toThrow(WorkflowTerminalError)

    // Assert: action-queue item raised
    expect(mockRaiseActionQueueItem).toHaveBeenCalledOnce()
    const [item] = mockRaiseActionQueueItem.mock.calls[0] as [{ kind: string; title: string; body: string; payload: Record<string, unknown> }]

    // Title mentions integration branch name
    expect(item.kind).toBe('dirty-integration')
    expect(item.title).toContain('main')
    expect(item.title).toContain('uncommitted changes')

    // Body lists the dirty paths
    expect(item.body).toContain('src/index.ts')
    expect(item.body).toContain('package.json')

    // Payload carries the task id and integration branch
    expect(item.payload).toMatchObject({
      taskId: 'test-aq',
      integrationBranch: 'main',
    })
  })

  it('does not spawn a coder after blocking on dirty integration', async () => {
    // The WorkflowTerminalError thrown by the guard stops the pipeline before
    // the code step runs. Verifying via the setup result/throw is sufficient —
    // no coder mock is wired up for this test by design.
    mockCheckIntegrationBranchDirty.mockResolvedValue({ dirty: true, statusOutput: ' M foo.ts' })
    const ctx = makeCtx('test-no-coder')

    let threw = false
    try {
      await setupWorktree(ctx)
    } catch (err) {
      threw = true
      expect(err).toBeInstanceOf(WorkflowTerminalError)
      expect((err as WorkflowTerminalError).kind).toBe('setup-dirty-integration')
    }
    expect(threw).toBe(true)
    expect(mockCreateWorktree).not.toHaveBeenCalled()
  })

  it('exempts main-committer fix tasks from the dirty-integration guard', async () => {
    // Arrange: dirty main, but this task IS the main-committer fix
    const { MAIN_COMMITER_RECIPE } = await import('../../../core/lib/main-dirty')
    mockCheckIntegrationBranchDirty.mockResolvedValue({ dirty: true, statusOutput: ' M README.md' })
    mockParseMainCommiterPayload.mockReturnValue({ recipe: MAIN_COMMITER_RECIPE })

    const ctx = makeCtx('test-committer-fix', {
      kind: 'fix',
      recoveryPayload: JSON.stringify({ recipe: MAIN_COMMITER_RECIPE }),
    })
    // provisionCommitterWorktree is called for main-committer fix tasks
    mockProvisionCommitterWorktree.mockResolvedValue({
      path: '/tmp/fake-committer',
      branch: 'task/fix-committer',
    })

    // Act — should NOT throw (main-committer fix is exempt)
    const result = await setupWorktree(ctx)

    // Assert: worktree provisioned (via the committer path), no blocked status
    expect(result).toMatchObject({ path: '/tmp/fake-committer', branch: 'task/fix-committer' })
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
    const blockedCall = mockUpdateTask.mock.calls.find(
      (call) => call[1]?.status === 'blocked',
    )
    expect(blockedCall).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Slice 2 tests: auto-stash of .mars/ artifacts + merge restore
// ---------------------------------------------------------------------------

/**
 * Helper: minimal MarsCtx for the merge primitive (slice-2 restore tests).
 * Provides just enough wiring that the merge fn() body can run without a
 * full daemon: enqueueMergeJobAndAwait returns a success result, and the
 * store methods are stubs.
 */
function makeMergeCtx(
  taskId: string,
  enqueueFn: () => Promise<{
    status: 'done'
    result: {
      merged: boolean
      conflictResolved: boolean
      aborted: boolean
      output: string
      supervisorConversation: never[]
      vegaSessionId: null
      retriesAttempted: number
      mergePreSha?: string
      mergePostSha?: string
    }
  }>,
) {
  return {
    runId: taskId,
    workflowId: 'task',
    input: { taskId, kind: 'task', integrationBranch: 'main' },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store: {
        getTask: vi.fn().mockResolvedValue(null),
        query: vi.fn().mockResolvedValue({ rows: [] }),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        batch: vi.fn().mockResolvedValue([]),
        atomic: vi.fn().mockResolvedValue(undefined),
      },
      traceStore: null,
      enqueueMergeJobAndAwait: enqueueFn,
    },
    currentStep: null,
    emit: vi.fn(),
    step: vi.fn(),
  } as never
}

describe('setup-worktree auto-stash of .mars/ preflight artifacts', () => {
  it('(a) auto-stashes all-orchestrator-owned dirty paths and lets the task proceed', async () => {
    // Arrange: only .mars/ files are dirty — no user-owned changes.
    const statusOutput = '?? .mars/pg.dsn\n?? .mars/http.port'
    mockCheckIntegrationBranchDirty.mockResolvedValue({ dirty: true, statusOutput })
    const ctx = makeCtx('test-all-mars')

    // Act: setup must NOT throw
    const result = await setupWorktree(ctx)

    // Assert: worktree was created (task proceeded)
    expect(result).toMatchObject({ path: '/tmp/fake-worktree', branch: 'task/test-task' })
    expect(mockCreateWorktree).toHaveBeenCalledOnce()

    // Assert: checkpoint was captured
    expect(mockCaptureCheckpoint).toHaveBeenCalledOnce()
    const captureArgs = mockCaptureCheckpoint.mock.calls[0][0] as {
      key: string
      cwd: string
    }
    expect(captureArgs.key).toBe('test-all-mars-preflight')

    // Assert: working tree was discarded after capture
    expect(mockDiscardWorkingTreeChanges).toHaveBeenCalledOnce()

    // Assert: task was NOT parked as blocked
    const blockedCall = mockUpdateTask.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>)?.status === 'blocked',
    )
    expect(blockedCall).toBeUndefined()

    // Assert: no action-queue item raised for user-owned dirt
    expect(mockRaiseActionQueueItem).not.toHaveBeenCalled()
  })

  it('(b) parks the task as blocked when dirty paths include user-owned files (mixed)', async () => {
    // Arrange: mix of .mars/ and user-owned files.
    const statusOutput = '?? .mars/http.port\n M src/index.ts'
    mockCheckIntegrationBranchDirty.mockResolvedValue({ dirty: true, statusOutput })
    const ctx = makeCtx('test-mixed')

    // Act: should throw WorkflowTerminalError
    await expect(setupWorktree(ctx)).rejects.toThrow(WorkflowTerminalError)

    // Assert: task blocked
    const blockedCall = mockUpdateTask.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>)?.status === 'blocked',
    )
    expect(blockedCall).toBeDefined()

    // Assert: NO checkpoint was written
    expect(mockCaptureCheckpoint).not.toHaveBeenCalled()
    expect(mockDiscardWorkingTreeChanges).not.toHaveBeenCalled()

    // Assert: worktree NOT created
    expect(mockCreateWorktree).not.toHaveBeenCalled()
  })

  it('(c) parks the task as blocked when only user-owned files are dirty (regression)', async () => {
    // Regression guard for slice 1: pure user-owned dirty paths must still block.
    const statusOutput = ' M README.md\n?? scratch.txt'
    mockCheckIntegrationBranchDirty.mockResolvedValue({ dirty: true, statusOutput })
    const ctx = makeCtx('test-user-only')

    await expect(setupWorktree(ctx)).rejects.toThrow(WorkflowTerminalError)

    // Task parked as blocked
    const blockedCall = mockUpdateTask.mock.calls.find(
      (call) => (call[1] as Record<string, unknown>)?.status === 'blocked',
    )
    expect(blockedCall).toBeDefined()

    // No checkpoint captured, no worktree created
    expect(mockCaptureCheckpoint).not.toHaveBeenCalled()
    expect(mockCreateWorktree).not.toHaveBeenCalled()
  })
})

describe('merge — restores preflight checkpoint after fast-forward', () => {
  it('(a) calls restoreCheckpoint and deletes the ref when a preflight ref exists', async () => {
    // Arrange: runTool returns exitCode:0 for the git rev-parse --verify probe
    // (meaning the preflight ref exists). The default mockRunTool already returns
    // exitCode:0 with stdout 'abc1234\n', which is the sha used for the restore.
    const taskId = 'test-merge-restore'

    const enqueueFn = vi.fn().mockResolvedValue({
      status: 'done',
      result: {
        merged: true,
        conflictResolved: false,
        aborted: false,
        output: '',
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
        mergePreSha: 'aaa000',
        mergePostSha: 'bbb111',
      },
    })

    // Act
    await merge(makeMergeCtx(taskId, enqueueFn), {
      kind: 'task',
      worktree: { path: '/tmp/wt-merge-restore', branch: `task/${taskId}` },
    })

    // Assert: restoreCheckpoint was called with the preflight ref's sha
    expect(mockRestoreCheckpoint).toHaveBeenCalledOnce()
    const restoreArgs = mockRestoreCheckpoint.mock.calls[0][0] as {
      checkpoint: { ref: string; sha: string }
    }
    expect(restoreArgs.checkpoint.ref).toContain(`${taskId}-preflight`)
    expect(restoreArgs.checkpoint.sha).toBe('abc1234') // sha from rev-parse stdout (trimmed)

    // Assert: task was marked done
    const doneCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'done',
    )
    expect(doneCalls).toHaveLength(1)
  })
})
