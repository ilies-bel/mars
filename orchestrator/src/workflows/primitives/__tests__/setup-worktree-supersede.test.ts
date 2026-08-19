/**
 * Regression: `setupWorktree` must reuse a supersede-inherited branch instead
 * of silently discarding it.
 *
 * THE BUG. `mars task add --supersede <id>` is documented (CLAUDE.md,
 * "Recovering a failed task") to make the replacement task INHERIT the
 * superseded task's branch — that is the entire reason to reach for
 * `--supersede` instead of `mars restart` when a recovery-exhausted arc
 * holds salvageable commits. `Arc.createOrigin` (arc.ts) does its part
 * correctly: it checks out a fresh worktree ON the superseded branch and
 * stamps `branch`/`worktree_path` onto the new task's row.
 *
 * But the dispatcher's setup step (this file) never reads those stamped
 * fields. Its worktree-reuse branch hardcodes `expectedBranch =
 * task/<taskId>` — the NEW task's own id, not the inherited branch name
 * (`task/<supersededId>`). `checkWorktreeIntegrity` then sees a branch
 * mismatch (`reason: 'wrong-branch'`) and falls through to `createWorktree`,
 * which carves a brand-new `task/<taskId>` branch off `main` — discarding
 * every commit the supersede was meant to carry forward. If the operator
 * then drops the (now `dropped`, but still branch-bearing) origin task to
 * clear its action-queue alert, that branch — the only place the inherited
 * commit still lived — is deleted too, and the work is unrecoverable.
 *
 * The fix: prefer the task row's already-stamped `branch`/`worktreePath`
 * over the `task/<taskId>` naming convention whenever both are set.
 *
 * Acceptance:
 *   A. A task row pre-stamped with an inherited branch/worktreePath (as
 *      `Arc.createOrigin`'s supersede path leaves it) is reused as-is:
 *      `createWorktree` is never called, and the returned ref carries the
 *      INHERITED branch name, not `task/<taskId>`.
 *   B. The task row is updated with that same inherited branch/worktreePath
 *      (not the naming-convention values).
 *   C. A task row with no pre-stamped branch/worktreePath (the ordinary,
 *      non-supersede case) is unaffected: `task/<taskId>` naming convention
 *      still applies and `createWorktree` still runs on a cold start.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { __resetContextCacheForTests } from '../../../core/context'
import type { Task } from '../../../core/queue'

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before any top-level awaits)
// ---------------------------------------------------------------------------

const {
  mockUpdateTask,
  mockHasIncompleteBlockers,
  mockGetTask,
  mockCreateWorktree,
  mockSyncWorktreeToIntegration,
  mockInstallWorktreeDeps,
  mockRunTool,
  mockCheckIntegrationBranchDirty,
  mockParseMainCommiterPayload,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockHasIncompleteBlockers: vi.fn().mockResolvedValue(false),
  mockGetTask: vi.fn().mockResolvedValue(null),
  mockCreateWorktree: vi
    .fn()
    .mockResolvedValue({ path: '/tmp/fresh-worktree', branch: 'task/fresh-id' }),
  mockSyncWorktreeToIntegration: vi.fn().mockResolvedValue({ kind: 'already-current' }),
  mockInstallWorktreeDeps: vi.fn().mockResolvedValue({ sites: [], totalDurationMs: 0 }),
  mockRunTool: vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: 'abc1234\n',
    stderr: '',
    durationMs: 1,
    traceEventId: 'trace-1',
  }),
  mockCheckIntegrationBranchDirty: vi.fn().mockResolvedValue({ dirty: false, statusOutput: '' }),
  mockParseMainCommiterPayload: vi.fn().mockReturnValue(null),
}))

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return {
    ...orig,
    updateTask: mockUpdateTask,
    hasIncompleteBlockers: mockHasIncompleteBlockers,
    getTask: mockGetTask,
  }
})

vi.mock('../../../core/lib/main-dirty', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/main-dirty')>()
  return {
    ...orig,
    checkIntegrationBranchDirty: mockCheckIntegrationBranchDirty,
    parseMainCommiterPayload: mockParseMainCommiterPayload,
  }
})

// `checkWorktreeIntegrity` is intentionally left REAL — it is the mechanism
// under test. Only `createWorktree` (the fallback path) and
// `syncWorktreeToIntegration` (irrelevant post-resolution replay logic) are
// stubbed.
vi.mock('../../../core/lib/git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/worktree')>()
  return {
    ...orig,
    createWorktree: mockCreateWorktree,
    syncWorktreeToIntegration: mockSyncWorktreeToIntegration,
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

vi.mock('../../../core/lib/run-tool', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/run-tool')>()
  return { ...orig, runTool: mockRunTool }
})

vi.mock('../../../core/queue-fix-tasks', () => ({
  handleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
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
const { setupWorktree } = await import('../index')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let repoRoot: string

const git = (args: string[], cwd: string): void => {
  execFileSync('git', args, { cwd })
}

function makeCtx(taskId: string, storeGetTask: ReturnType<typeof vi.fn>) {
  return {
    runId: taskId,
    workflowId: 'task',
    input: {
      taskId,
      kind: 'task',
      integrationBranch: 'main',
      recoveryPayload: null,
      fixForTaskId: null,
    },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store: {
        getTask: storeGetTask,
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

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

beforeEach(() => {
  repoRoot = mkdtempSync(resolve(tmpdir(), 'mars-supersede-setup-'))
  git(['init', '-q', '-b', 'main'], repoRoot)
  git(['config', 'user.email', 'test@example.com'], repoRoot)
  git(['config', 'user.name', 'test'], repoRoot)
  writeFileSync(resolve(repoRoot, 'app.ts'), 'export const app = 1\n')
  git(['add', 'app.ts'], repoRoot)
  git(['commit', '-m', 'init'], repoRoot)

  process.env.MARS_REPO = repoRoot
  __resetContextCacheForTests()

  mockUpdateTask.mockReset().mockResolvedValue(undefined)
  mockHasIncompleteBlockers.mockReset().mockResolvedValue(false)
  mockGetTask.mockReset().mockResolvedValue(null)
  mockCreateWorktree
    .mockReset()
    .mockResolvedValue({ path: '/tmp/fresh-worktree', branch: 'task/fresh-id' })
  mockSyncWorktreeToIntegration.mockReset().mockResolvedValue({ kind: 'already-current' })
  mockInstallWorktreeDeps.mockReset().mockResolvedValue({ sites: [], totalDurationMs: 0 })
  mockRunTool.mockReset().mockResolvedValue({
    exitCode: 0,
    stdout: 'abc1234\n',
    stderr: '',
    durationMs: 1,
    traceEventId: 'trace-1',
  })
  mockCheckIntegrationBranchDirty.mockReset().mockResolvedValue({ dirty: false, statusOutput: '' })
  mockParseMainCommiterPayload.mockReset().mockReturnValue(null)
})

afterEach(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('setupWorktree — supersede-inherited branch', () => {
  it('(A) reuses the inherited branch/worktree; createWorktree is never called', async () => {
    const supersededId = 'mars-6340b827'
    const newTaskId = 'mars-68870bba'
    const inheritedBranch = `task/${supersededId}`
    const inheritedWorktreePath = resolve(repoRoot, '.mars', 'worktrees', newTaskId)

    // Reproduce exactly what Arc.createOrigin's supersede preamble does:
    // `git worktree add <newPath> <supersededBranch>` — a NEW worktree
    // directory, checked out on the OLD (superseded) branch name.
    mkdirSync(resolve(inheritedWorktreePath, '..'), { recursive: true })
    git(['branch', inheritedBranch], repoRoot)
    git(['worktree', 'add', inheritedWorktreePath, inheritedBranch], repoRoot)
    // A real commit landed on the inherited branch — this is the salvage
    // checkpoint the supersede exists to carry forward.
    writeFileSync(resolve(inheritedWorktreePath, 'salvaged.ts'), 'export const salvaged = 1\n')
    git(['add', 'salvaged.ts'], inheritedWorktreePath)
    git(['commit', '-m', 'chore(auto-commit): salvage checkpoint'], inheritedWorktreePath)

    // The task row, as Arc.createOrigin left it: branch/worktreePath already
    // stamped to the inherited values (not `task/<newTaskId>`).
    const storeGetTask = vi.fn().mockResolvedValue({
      id: newTaskId,
      tags: ['coder'],
      originId: 'mars-origin',
      status: 'queued',
      branch: inheritedBranch,
      worktreePath: inheritedWorktreePath,
    } as unknown as Task)

    const ctx = makeCtx(newTaskId, storeGetTask)

    const result = await setupWorktree(ctx)

    // The inherited branch survives — NOT `task/<newTaskId>`.
    expect(result.branch).toBe(inheritedBranch)
    expect(result.path).toBe(inheritedWorktreePath)

    // createWorktree (which would have branched fresh off `main`, discarding
    // the salvage commit) must never have been invoked.
    expect(mockCreateWorktree).not.toHaveBeenCalled()

    // (B) The task row is persisted with the inherited values, not the
    // `task/<taskId>` naming convention.
    const branchUpdateCall = mockUpdateTask.mock.calls.find(
      (c) => (c[1] as Record<string, unknown>)?.branch !== undefined,
    )
    expect(branchUpdateCall).toBeDefined()
    expect((branchUpdateCall![1] as Record<string, unknown>).branch).toBe(inheritedBranch)
    expect((branchUpdateCall![1] as Record<string, unknown>).worktreePath).toBe(
      inheritedWorktreePath,
    )
  })

  it('(C) ordinary task (no pre-stamped branch) still uses the task/<id> convention and calls createWorktree', async () => {
    const taskId = 'mars-plain01'

    const storeGetTask = vi.fn().mockResolvedValue({
      id: taskId,
      tags: ['coder'],
      originId: taskId,
      status: 'queued',
      branch: null,
      worktreePath: null,
    } as unknown as Task)

    const ctx = makeCtx(taskId, storeGetTask)

    const result = await setupWorktree(ctx)

    expect(mockCreateWorktree).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ path: '/tmp/fresh-worktree', branch: 'task/fresh-id' })
  })
})
