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

// Import the primitive AFTER all vi.mock() calls.
const { setupWorktree } = await import('../index')

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
