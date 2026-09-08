/**
 * `runAgent` must never put a second coder into a worktree that already holds
 * a live lease.
 *
 * The incident this locks down (`fix-2b98a126`): two coder agents ran
 * concurrently in `.mars/worktrees/mars-40486f27`. HEAD moved under the second
 * agent mid-run, and the other agent's `git add -A` swept a throwaway probe
 * file into a real commit that then failed the suite unconditionally.
 *
 * Acceptance criteria:
 *   a) a live lease held by ANOTHER task → the coder is never spawned,
 *      WorkflowTerminalError('worktree-lease-held') is thrown (the message
 *      names the holder so an operator can act), and the task is RE-QUEUED
 *      (not failed) so the recovery budget (ADR-0040: one fix-task per origin)
 *      is not consumed on an attempt that never ran an agent.
 *   b) while a coder is running, a competing acquire on the same worktree is
 *      refused — and the lease is released once the run finishes
 *   c) a lease left behind by a dead process does not block the coder
 *
 * The lease itself is real (a file on disk, pid liveness by `process.kill`);
 * only the coder subprocess and the task store are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { WorkflowTerminalError } from '../../../core/lib/workflow-terminal-error'
import {
  acquireWorktreeLease,
  readLiveWorktreeLease,
  worktreeLeasePath,
  WorktreeLeaseHeldError,
} from '../../../core/lib/git/worktree-lease'

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

// Import runAgent AFTER vi.mock() hoisting is complete.
const { runAgent } = await import('../index')

function makeCtx(taskId: string, store: object) {
  return {
    runId: taskId,
    workflowId: 'task',
    input: { taskId, kind: 'task', prompt: 'implement it', tags: ['coder'] },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: { store, traceStore: null, onPid: vi.fn() },
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

function successResult() {
  return {
    exitCode: 0,
    stderr: '',
    stdout: '',
    sessionId: null,
    conversation: [{ type: 'assistant', content: 'done' }] as unknown[],
    quotaRejected: null as null,
  }
}

/** A temp repo on `task/test-id` with one commit ahead of main. */
function initRepoWithCommit(): string {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-lease-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README'), 'hello\n')
  execFileSync('git', ['add', 'README'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  execFileSync('git', ['checkout', '-q', '-b', 'task/test-id', 'main'], { cwd: repo })
  writeFileSync(resolve(repo, 'feature.ts'), 'export const ok = true\n')
  execFileSync('git', ['add', 'feature.ts'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'feat: feature'], { cwd: repo })
  return repo
}

describe('runAgent — exclusive worktree lease', () => {
  let repo: string

  beforeEach(() => {
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
    mockSyncWorktreeToIntegration.mockResolvedValue({ kind: 'already-current' })
    repo = initRepoWithCommit()
  })

  afterEach(() => {
    if (repo) {
      rmSync(repo, { recursive: true, force: true })
      rmSync(worktreeLeasePath(repo), { force: true })
    }
  })

  // ── (a) another task already holds the tree ────────────────────────────────

  it('refuses to spawn a coder into a worktree held by another task', async () => {
    await acquireWorktreeLease({
      worktreePath: repo,
      taskId: 'mars-40486f27',
      branch: 'task/mars-40486f27',
    })
    mockRunWorkerWithSpan.mockResolvedValue(successResult())

    const err = await runAgent(makeCtx('fix-2b98a126', makeStore()), {
      worktree: { path: repo, branch: 'task/test-id' },
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(WorkflowTerminalError)
    expect((err as WorkflowTerminalError).kind).toBe('worktree-lease-held')
    // The holder is named so an operator knows whose run to wait on or stop.
    expect((err as WorkflowTerminalError).message).toContain('mars-40486f27')

    // The whole point: no second agent ever entered the tree.
    expect(mockRunWorkerWithSpan).not.toHaveBeenCalled()

    // The task is RE-QUEUED (not failed) so the one recovery slot (ADR-0040)
    // is not burned on an attempt that never ran. No failureReason is set.
    const requeueCall = mockUpdateTask.mock.calls.find(
      (c: unknown[]) => (c[1] as { status?: string }).status === 'queued',
    )
    expect(requeueCall).toBeDefined()
    const requeuePatch = requeueCall?.[1] as Record<string, unknown>
    expect(requeuePatch?.failureReason).toBeUndefined()
    expect(requeuePatch?.status).toBe('queued')
  })

  it('leaves the holder\'s lease intact after refusing', async () => {
    await acquireWorktreeLease({ worktreePath: repo, taskId: 'mars-40486f27' })

    await runAgent(makeCtx('fix-2b98a126', makeStore()), {
      worktree: { path: repo, branch: 'task/test-id' },
    }).catch(() => undefined)

    expect((await readLiveWorktreeLease(repo))?.taskId).toBe('mars-40486f27')
  })

  // ── (b) the running coder owns the tree, and gives it back ─────────────────

  it('holds the tree for the duration of the coder run and releases it after', async () => {
    let competitorRefused = false
    mockRunWorkerWithSpan.mockImplementation(async () => {
      // A second dispatch arriving mid-run — the exact race that produced the
      // cross-contamination — must be turned away while the coder is live.
      const outcome = await acquireWorktreeLease({
        worktreePath: repo,
        taskId: 'fix-competitor',
      }).catch((e: unknown) => e)
      competitorRefused = outcome instanceof WorktreeLeaseHeldError
      return successResult()
    })

    await runAgent(makeCtx('test-id', makeStore()), {
      worktree: { path: repo, branch: 'task/test-id' },
    })

    expect(mockRunWorkerWithSpan).toHaveBeenCalledTimes(1)
    expect(competitorRefused).toBe(true)
    // Released on the way out — a leaked lease would refuse every later
    // dispatch onto this worktree until the daemon itself died.
    expect(existsSync(worktreeLeasePath(repo))).toBe(false)
  })

  // ── (c) a dead holder is not a holder ──────────────────────────────────────

  it('runs normally when the recorded holder process is gone', async () => {
    // A genuinely dead pid, not an invented one: spawn a process, let it exit,
    // then claim the tree in its name. This is the daemon-crashed case — if a
    // dead holder blocked dispatch, every worktree it held would be stranded.
    const child = spawnSync(process.execPath, ['-e', ''])
    expect(child.status).toBe(0)

    writeFileSync(
      worktreeLeasePath(repo),
      JSON.stringify({
        taskId: 'mars-crashed',
        branch: 'task/mars-crashed',
        pid: child.pid,
        acquiredAt: Date.now() - 3_600_000,
      }),
      'utf8',
    )
    mockRunWorkerWithSpan.mockResolvedValue(successResult())

    await runAgent(makeCtx('test-id', makeStore()), {
      worktree: { path: repo, branch: 'task/test-id' },
    })

    expect(mockRunWorkerWithSpan).toHaveBeenCalledTimes(1)
  })

  // ── (d) the coder's real subprocess pid is written into the lease ──────────
  //
  // This is the fix for fix-8dec62b2 / mars-ad9fc5cb: the daemon's pid was
  // recorded instead of the coder's, so the lease always looked live (daemon
  // is alive) even after the coder subprocess had died. By writing the real
  // subprocess pid via the onPid wrapper, a dead coder is correctly detected
  // as stale on the next read.

  it('updates the lease to the coder subprocess pid when onPid fires', async () => {
    // Use a fresh repo so we can inspect the sibling lease file.
    const pidRepo = initRepoWithCommit()
    afterEach(() => { rmSync(pidRepo, { recursive: true, force: true }) })

    const fakePid = process.pid + 999 // arbitrary value distinct from process.pid

    // Read the lease pid mid-run, immediately after the mock fires onPid.
    let pidSeenInLease: number | undefined
    mockRunWorkerWithSpan.mockImplementation(async (...args: unknown[]) => {
      const runOptions = (args[0] as { runOptions?: { onPid?: (pid: number) => void } }).runOptions
      // Fire onPid as a subprocess would.
      runOptions?.onPid?.(fakePid)
      // Give updatePid's async write a tick to settle.
      await new Promise<void>((r) => setTimeout(r, 0))
      try {
        const { readFileSync } = await import('node:fs')
        pidSeenInLease = JSON.parse(readFileSync(worktreeLeasePath(pidRepo), 'utf8')).pid
      } catch {
        // File absent (released early) — leave undefined.
      }
      return successResult()
    })

    await runAgent(makeCtx('test-id-pid', makeStore()), {
      worktree: { path: pidRepo, branch: 'task/test-id' },
    })

    // The lease was updated to the coder's subprocess pid, not the daemon's.
    expect(pidSeenInLease).toBe(fakePid)
  })

  it('a dead coder pid allows a recovery task to acquire the tree without budget cost', async () => {
    // Scenario: fix-8dec62b2 / mars-ad9fc5cb.
    //   1. Origin coder ran, registered its subprocess pid via onPid.
    //   2. Coder subprocess died (pid is now dead).
    //   3. A recovery task tries to run in the same worktree.
    //      With the old code (daemon pid in lease, daemon always alive) → refused.
    //      With the fix (dead coder pid in lease) → stale, released, succeeds.
    const deadChild = spawnSync(process.execPath, ['-e', ''])
    expect(deadChild.status).toBe(0)
    const deadCoderPid = deadChild.pid as number

    // Simulate the stale lease left by a dead coder subprocess.
    writeFileSync(
      worktreeLeasePath(repo),
      JSON.stringify({
        taskId: 'mars-ad9fc5cb', // the ORIGIN task, not the recovery
        branch: 'task/mars-ad9fc5cb',
        pid: deadCoderPid,       // coder's dead pid (NOT the daemon's pid)
        acquiredAt: Date.now() - 120_000,
      }),
      'utf8',
    )

    // Recovery task runs in the same worktree (kind=fix reuses origin tree).
    mockRunWorkerWithSpan.mockResolvedValue(successResult())

    // Must not throw WorkflowTerminalError('worktree-lease-held') — the stale
    // lease must be released on read, and the recovery must proceed normally.
    await expect(
      runAgent(makeCtx('fix-8dec62b2', makeStore()), {
        worktree: { path: repo, branch: 'task/mars-ad9fc5cb' },
      }),
    ).resolves.toBeDefined()

    expect(mockRunWorkerWithSpan).toHaveBeenCalledTimes(1)
    // handleTaskFailureWithFixTask must NOT have been called — the recovery
    // budget is untouched.
    expect(mockHandleTaskFailureWithFixTask).not.toHaveBeenCalled()
  })
})
