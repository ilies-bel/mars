/**
 * Tests for the salvage-checkpoint-tip guard in the `merge()` primitive.
 *
 * Context (see the incident writeup that spawned this task): when a coder is
 * killed mid-run with uncommitted changes, `coder-exit.ts` auto-commits them
 * as a "salvage checkpoint" — a commit whose subject starts with
 * `wip(checkpoint): ... — do not merge as-is` and whose BODY carries a
 * structural `Mars-Checkpoint: salvage` trailer (`checkpoint.ts`'s
 * `SALVAGE_CHECKPOINT_TRAILER_KEY`/`_VALUE`). That commit is a safety net for
 * the *coder-resume* path (`mars continue` rewinds to the coder on the same
 * worktree so it can finish the work) — it was never meant to be shippable on
 * its own. Commit `cb61d68c` on `main` is exactly that: a checkpoint that
 * reached `main` because nothing refused it at merge time.
 *
 * `merge()` now refuses to fast-forward a branch whose TIP carries the
 * `Mars-Checkpoint: salvage` trailer, checked via `isSalvageCheckpointCommit`
 * (a real `git log --format=%(trailers:...)` read) — not a subject-line grep.
 * A refused branch is further classified via `hasRealCommitAboveBase`
 * (`base..tip` against `merge-base(branch, integrationBranch)`) into two
 * distinct shapes so identical-looking refusals don't collapse into one
 * storm signature:
 *
 *  - real progress underneath (some non-checkpoint commit exists between the
 *    base and the tip): a genuine merge defect, `failedPhase: 'merge'`,
 *    signature `merge:salvage-checkpoint-tip/resumed-then-died`.
 *  - no progress at all (every commit above the base is itself a
 *    checkpoint, across any `--supersede` inheritance): classified as a
 *    code-phase failure instead, `failedPhase: 'code'`, signature
 *    `code:salvage-checkpoint-tip/no-progress`.
 *
 * These tests exercise that guard against a REAL git repository (the trailer
 * parsing is a real git primitive, not something worth mocking) and assert:
 *
 *  1. a branch tipped by a checkpoint WITH a real commit underneath is
 *     refused as a genuine merge defect, with a message naming `mars
 *     continue` and `--supersede`;
 *  2. a branch tipped by a checkpoint with NO real commit anywhere above the
 *     inherited base is refused as a code-phase, no-progress failure,
 *     pointing at supersede-again-or-split;
 *  3. a branch with a checkpoint commit in its history, but real commits on
 *     top, is NOT refused — merge proceeds past the guard normally;
 *  4. a human commit whose subject happens to start with `wip(checkpoint):`
 *     but carries no trailer is NOT refused — the check is structural, not
 *     textual.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { __resetContextCacheForTests } from '../../../core/context'
import { WorkflowTerminalError } from '../../../core/lib/workflow-terminal-error'
import {
  SALVAGE_CHECKPOINT_SUBJECT_PREFIX,
  SALVAGE_CHECKPOINT_TRAILER_KEY,
  SALVAGE_CHECKPOINT_TRAILER_VALUE,
} from '../../../core/lib/git/checkpoint'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockUpdateTask,
  mockGetTask,
  mockIsZeroCommitBranch,
  mockCheckMergeTargetStatus,
  mockRemoveWorktree,
  mockHandleTaskFailureWithFixTask,
  mockRaiseActionQueueItem,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockGetTask: vi.fn().mockResolvedValue(null),
  mockIsZeroCommitBranch: vi.fn().mockResolvedValue(false),
  mockCheckMergeTargetStatus: vi.fn().mockRejectedValue(new Error('SENTINEL_PAST_GUARD')),
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
  mockHandleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
  mockRaiseActionQueueItem: vi.fn().mockResolvedValue('aq-id'),
}))

// ---------------------------------------------------------------------------
// Module mocks — deliberately do NOT mock `core/context`: the guard shells
// out to real git (`rev-parse`, `log --format=%(trailers:...)`) against
// `resolveContext().repoRoot`, so the test points that at a real temp repo
// via MARS_REPO instead of stubbing it out.
// ---------------------------------------------------------------------------

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return { ...orig, updateTask: mockUpdateTask, getTask: mockGetTask }
})

vi.mock('../../../core/lib/git/merge', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/merge')>()
  return {
    ...orig,
    isZeroCommitBranch: mockIsZeroCommitBranch,
    checkMergeTargetStatus: mockCheckMergeTargetStatus,
  }
})

vi.mock('../../../core/lib/git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/git/worktree')>()
  return { ...orig, removeWorktree: mockRemoveWorktree }
})

vi.mock('../../../core/lib/origin', () => ({
  resolveOriginIdForTask: async (id: string) => id,
}))

// Strip the span wrapper so merge() runs the inner fn() directly.
vi.mock('../../../core/lib/run-worker-with-span', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/run-worker-with-span')>()
  return {
    ...orig,
    runNonLlmStepWithSpan: async <T>(opts: { fn: () => Promise<T> }) => opts.fn(),
  }
})

vi.mock('../../../core/queue-fix-tasks', () => ({
  handleTaskFailureWithFixTask: mockHandleTaskFailureWithFixTask,
}))

vi.mock('../../../core/lib/action-queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/action-queue')>()
  return { ...orig, raiseActionQueueItem: mockRaiseActionQueueItem }
})

// ---------------------------------------------------------------------------
// Import module under test AFTER vi.mock() hoisting is complete.
// ---------------------------------------------------------------------------

const { merge } = await import('../merge.js')

// ---------------------------------------------------------------------------
// Real-git repo helpers
// ---------------------------------------------------------------------------

let repo: string
let prevMarsRepo: string | undefined

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-merge-salvage-tip-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@mars.local')
  git(dir, 'config', 'user.name', 'Mars Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(resolve(dir, 'README.md'), 'hi\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

let commitCounter = 0

/** Commit an arbitrary file change on whatever branch is currently checked out. */
const commitChange = (dir: string, message: string): string => {
  commitCounter += 1
  writeFileSync(resolve(dir, `file-${commitCounter}.txt`), `content ${commitCounter}\n`)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

/** The exact commit-message shape coder-exit.ts writes for a salvage checkpoint. */
const salvageCheckpointMessage = (): string =>
  `${SALVAGE_CHECKPOINT_SUBJECT_PREFIX} coder killed (exit 143) with 1 uncommitted path(s) — do not merge as-is\n\n${SALVAGE_CHECKPOINT_TRAILER_KEY}: ${SALVAGE_CHECKPOINT_TRAILER_VALUE}`

/** Create `branchName` off `main`, check it out, and return to `main` when done. */
const onNewBranch = (dir: string, branchName: string, build: () => void): void => {
  git(dir, 'checkout', '-q', '-b', branchName, 'main')
  build()
  git(dir, 'checkout', '-q', 'main')
}

beforeEach(() => {
  repo = setupRepo()
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repo
  __resetContextCacheForTests()
  vi.clearAllMocks()
  mockGetTask.mockResolvedValue(null)
  mockUpdateTask.mockResolvedValue(undefined)
  mockIsZeroCommitBranch.mockResolvedValue(false)
  mockCheckMergeTargetStatus.mockRejectedValue(new Error('SENTINEL_PAST_GUARD'))
  mockRemoveWorktree.mockResolvedValue(undefined)
  mockHandleTaskFailureWithFixTask.mockResolvedValue({ outcome: 'fix-task-spawned' })
  mockRaiseActionQueueItem.mockResolvedValue('aq-id')
})

afterEach(() => {
  if (prevMarsRepo === undefined) delete process.env.MARS_REPO
  else process.env.MARS_REPO = prevMarsRepo
  __resetContextCacheForTests()
  rmSync(repo, { recursive: true, force: true })
})

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

/** Minimal MarsCtx stub. `opts.worktree` bypasses resolveWorktree's store fallback. */
const makeCtx = (taskId: string) =>
  ({
    runId: taskId,
    workflowId: 'task',
    input: { taskId, kind: 'task', integrationBranch: 'main' },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store: {
        getTask: mockGetTask,
        query: vi.fn().mockResolvedValue({ rows: [] }),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        batch: vi.fn().mockResolvedValue([]),
        atomic: vi.fn().mockResolvedValue(undefined),
      },
      traceStore: null,
    },
    currentStep: null,
    emit: vi.fn(),
    step: vi.fn(),
  }) as never

const worktreeOpts = (taskId: string, branch: string) => ({
  worktree: { path: `/tmp/wt-${taskId}`, branch },
})

// ---------------------------------------------------------------------------
// Suite 1 — salvage checkpoint AT the tip, real progress underneath: refused
// as a genuine merge defect
// ---------------------------------------------------------------------------

describe('merge — salvage-checkpoint-tip guard: refuses a branch tipped by a checkpoint (real progress underneath)', () => {
  it('throws WorkflowTerminalError with kind merge-salvage-checkpoint-tip', async () => {
    const taskId = 'mars-salvage-tip-01'
    const branch = `task/${taskId}`
    onNewBranch(repo, branch, () => {
      commitChange(repo, 'feat: real work before the coder died')
      git(repo, 'commit', '-q', '--allow-empty', '-m', salvageCheckpointMessage())
    })

    const err = await merge(makeCtx(taskId), {
      kind: 'task',
      ...worktreeOpts(taskId, branch),
    }).catch((e) => e)

    expect(err).toBeInstanceOf(WorkflowTerminalError)
    expect((err as WorkflowTerminalError).kind).toBe('merge-salvage-checkpoint-tip')
  })

  it('names `mars continue` and `--supersede` in the failure message', async () => {
    const taskId = 'mars-salvage-tip-02'
    const branch = `task/${taskId}`
    onNewBranch(repo, branch, () => {
      commitChange(repo, 'feat: real work before the coder died')
      git(repo, 'commit', '-q', '--allow-empty', '-m', salvageCheckpointMessage())
    })

    await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId, branch) }).catch(
      () => {},
    )

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    const errorMsg = (failedCalls[0][1] as Record<string, unknown>).error as string
    expect(errorMsg).toContain(`mars continue ${taskId}`)
    expect(errorMsg).toContain(`mars task add --supersede ${taskId}`)
  })

  it('marks the task failed with failedPhase merge and signature merge:salvage-checkpoint-tip/resumed-then-died', async () => {
    const taskId = 'mars-salvage-tip-03'
    const branch = `task/${taskId}`
    onNewBranch(repo, branch, () => {
      commitChange(repo, 'feat: real work before the coder died')
      git(repo, 'commit', '-q', '--allow-empty', '-m', salvageCheckpointMessage())
    })

    await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId, branch) }).catch(
      () => {},
    )

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0][0]).toBe(taskId)
    expect((failedCalls[0][1] as Record<string, unknown>).failedPhase).toBe('merge')
    expect((failedCalls[0][1] as Record<string, unknown>).failureSignature).toBe(
      'merge:salvage-checkpoint-tip/resumed-then-died',
    )
  })

  it('does not proceed to checkMergeTargetStatus (stops before the normal merge path)', async () => {
    const taskId = 'mars-salvage-tip-04'
    const branch = `task/${taskId}`
    onNewBranch(repo, branch, () => {
      commitChange(repo, 'feat: real work before the coder died')
      git(repo, 'commit', '-q', '--allow-empty', '-m', salvageCheckpointMessage())
    })

    await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId, branch) }).catch(
      () => {},
    )

    expect(mockCheckMergeTargetStatus).not.toHaveBeenCalled()
  })

  it('raises an action-queue item naming mars continue / --supersede', async () => {
    const taskId = 'mars-salvage-tip-05'
    const branch = `task/${taskId}`
    onNewBranch(repo, branch, () => {
      commitChange(repo, 'feat: real work before the coder died')
      git(repo, 'commit', '-q', '--allow-empty', '-m', salvageCheckpointMessage())
    })

    await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId, branch) }).catch(
      () => {},
    )

    expect(mockRaiseActionQueueItem).toHaveBeenCalledOnce()
    const [item] = mockRaiseActionQueueItem.mock.calls[0]
    expect(item.raisedBy).toBe('merge:salvage-checkpoint-tip')
    expect(item.body).toContain(`mars continue ${taskId}`)
    expect(item.body).toContain(`mars task add --supersede ${taskId}`)
  })
})

// ---------------------------------------------------------------------------
// Suite 1b — salvage checkpoint AT the tip, NO real commit anywhere above the
// inherited base: refused as a distinct code-phase, no-progress failure so it
// does not collapse into the same storm signature as a genuine merge defect
// ---------------------------------------------------------------------------

describe('merge — salvage-checkpoint-tip guard: refuses with a distinct classification when the branch never held real progress', () => {
  it('throws WorkflowTerminalError with kind merge-salvage-checkpoint-tip-no-progress', async () => {
    const taskId = 'mars-salvage-noprog-01'
    const branch = `task/${taskId}`
    onNewBranch(repo, branch, () => {
      git(repo, 'commit', '-q', '--allow-empty', '-m', salvageCheckpointMessage())
    })

    const err = await merge(makeCtx(taskId), {
      kind: 'task',
      ...worktreeOpts(taskId, branch),
    }).catch((e) => e)

    expect(err).toBeInstanceOf(WorkflowTerminalError)
    expect((err as WorkflowTerminalError).kind).toBe('merge-salvage-checkpoint-tip-no-progress')
  })

  it('marks the task failed with failedPhase code and signature code:salvage-checkpoint-tip/no-progress', async () => {
    const taskId = 'mars-salvage-noprog-02'
    const branch = `task/${taskId}`
    onNewBranch(repo, branch, () => {
      git(repo, 'commit', '-q', '--allow-empty', '-m', salvageCheckpointMessage())
    })

    await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId, branch) }).catch(
      () => {},
    )

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>)?.status === 'failed',
    )
    expect(failedCalls).toHaveLength(1)
    expect(failedCalls[0][0]).toBe(taskId)
    expect((failedCalls[0][1] as Record<string, unknown>).failedPhase).toBe('code')
    expect((failedCalls[0][1] as Record<string, unknown>).failureSignature).toBe(
      'code:salvage-checkpoint-tip/no-progress',
    )
  })

  it('raises an action-queue item pointing at supersede-again-or-split, distinct raisedBy from the genuine-defect path', async () => {
    const taskId = 'mars-salvage-noprog-03'
    const branch = `task/${taskId}`
    onNewBranch(repo, branch, () => {
      git(repo, 'commit', '-q', '--allow-empty', '-m', salvageCheckpointMessage())
    })

    await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId, branch) }).catch(
      () => {},
    )

    expect(mockRaiseActionQueueItem).toHaveBeenCalledOnce()
    const [item] = mockRaiseActionQueueItem.mock.calls[0]
    expect(item.raisedBy).toBe('merge:salvage-checkpoint-tip-no-progress')
    expect(item.body).toContain(`mars task add --supersede ${taskId}`)
  })

  it('does not proceed to checkMergeTargetStatus (stops before the normal merge path)', async () => {
    const taskId = 'mars-salvage-noprog-04'
    const branch = `task/${taskId}`
    onNewBranch(repo, branch, () => {
      git(repo, 'commit', '-q', '--allow-empty', '-m', salvageCheckpointMessage())
    })

    await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId, branch) }).catch(
      () => {},
    )

    expect(mockCheckMergeTargetStatus).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Suite 2 — checkpoint in history, real commit on top: merges normally
// ---------------------------------------------------------------------------

describe('merge — salvage-checkpoint-tip guard: checkpoint NOT at tip is fine', () => {
  it('does not refuse when the coder resumed and committed real work on top', async () => {
    const taskId = 'mars-salvage-history-01'
    const branch = `task/${taskId}`
    onNewBranch(repo, branch, () => {
      git(repo, 'commit', '-q', '--allow-empty', '-m', salvageCheckpointMessage())
      commitChange(repo, 'feat: finish the work the coder resumed onto')
    })

    const err = await merge(makeCtx(taskId), {
      kind: 'task',
      ...worktreeOpts(taskId, branch),
    }).catch((e) => e)

    // The guard did not fire — the flow reached the real merge path and hit
    // our sentinel rejection from checkMergeTargetStatus instead.
    expect(err).not.toBeInstanceOf(WorkflowTerminalError)
    expect(mockCheckMergeTargetStatus).toHaveBeenCalledOnce()

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) =>
        (c[1] as Record<string, unknown>)?.failureSignature === 'merge:salvage-checkpoint-tip',
    )
    expect(failedCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Suite 3 — human commit with the same subject text, no trailer: not refused
// ---------------------------------------------------------------------------

describe('merge — salvage-checkpoint-tip guard: structural, not a subject-line grep', () => {
  it('does not refuse a human commit whose subject starts with wip(checkpoint): but carries no trailer', async () => {
    const taskId = 'mars-salvage-lookalike-01'
    const branch = `task/${taskId}`
    onNewBranch(repo, branch, () => {
      // Same subject prefix a real salvage checkpoint uses, deliberately
      // authored by a human with NO Mars-Checkpoint trailer in the body.
      git(
        repo,
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        `${SALVAGE_CHECKPOINT_SUBJECT_PREFIX} manually finishing up — do not merge as-is`,
      )
    })

    const err = await merge(makeCtx(taskId), {
      kind: 'task',
      ...worktreeOpts(taskId, branch),
    }).catch((e) => e)

    expect(err).not.toBeInstanceOf(WorkflowTerminalError)
    expect(mockCheckMergeTargetStatus).toHaveBeenCalledOnce()

    const failedCalls = mockUpdateTask.mock.calls.filter(
      (c) =>
        (c[1] as Record<string, unknown>)?.failureSignature === 'merge:salvage-checkpoint-tip',
    )
    expect(failedCalls).toHaveLength(0)
  })
})
