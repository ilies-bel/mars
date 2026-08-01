/**
 * Regression suite for the unbounded environmental-restart loop observed live
 * on task mars-6cf9774f (2026-08-01): 35 consecutive `environmental restart #1`
 * re-queues, verify step attempt 37, `env_restart_count` stuck at 1.
 *
 * Two independent defects produced it, and this file pins both:
 *
 *  1. THE REMEDY DID NOT RESTORE ITS PRECONDITION. `verify:worktree-missing` is
 *     correctly classified environmental, so the failure handler re-queues the
 *     origin instead of burning its recovery slot. But the re-queue only
 *     cleared the failure markers — it left the durable run journal intact, so
 *     the next dispatch resumed with `setup` already `'completed'`, skipped the
 *     only step that can build a worktree, and failed verify on the same absent
 *     directory. "Worktree is missing" was retried by a dispatch that
 *     structurally could not produce a worktree.
 *
 *  2. THE BOUND WAS INERT. `TASK_SEL` did not select `env_restart_count`, so
 *     every `getTask` read resolved it to 0. `envRestartCount <
 *     MAX_ENV_RESTART_ATTEMPTS` was therefore permanently true and the cap
 *     never fired, while the persisted column was rewritten to 1 each pass.
 *
 * The harness mirrors queue-fix-tasks.test.ts: one migrated template DB cloned
 * per test, modules re-imported against a fresh `MARS_REPO`.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { StepRecord } from '@mars/workflow'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface FixTasksModule {
  handleTaskFailureWithFixTask: typeof import('../../queue-fix-tasks').handleTaskFailureWithFixTask
  MAX_ENV_RESTART_ATTEMPTS: typeof import('../../queue-fix-tasks').MAX_ENV_RESTART_ATTEMPTS
}

interface StoreModule {
  createQueueWorkflowStore: typeof import('../../../workflows/queue-workflow-store').createQueueWorkflowStore
}

/**
 * The exact signature the verify-step resume preflight stamps when
 * `ResumeWorktreeUnrecoverable` fires: the worktree directory is gone AND the
 * branch is gone. Registered `environmental` in the failure-kinds registry —
 * that classification is load-bearing (it keeps N legitimate occurrences from
 * tripping the signature-storm breaker) and must NOT be traded away to fix the
 * loop.
 */
const WORKTREE_MISSING_SIG = 'verify:worktree-missing/unclassified'

/** The error text the preflight passes through as `errorOutput`. */
const unrecoverableError = (taskId: string): string =>
  `worktree for resumed task ${taskId} is unrecoverable: directory ` +
  `/tmp/absent/${taskId} is absent and branch 'task/${taskId}' no longer exists`

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-env-restart-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let templateRepo: string

const TEMPLATE_DB_FILES = ['queue.db', 'state.db'] as const

const cloneTemplateDbs = (destRepo: string): void => {
  for (const file of TEMPLATE_DB_FILES) {
    const src = resolve(templateRepo, '.mars', file)
    if (!existsSync(src)) continue
    copyFileSync(src, resolve(destRepo, '.mars', file))
  }
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; ft: FixTasksModule; ws: StoreModule }> => {
  try {
    const { closeAllDbs } = await import('../db')
    await closeAllDbs()
  } catch {
    // Non-fatal: first invocation or already-crashed instance.
  }
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const ft = (await import('../../queue-fix-tasks')) as unknown as FixTasksModule
  const ws = (await import(
    '../../../workflows/queue-workflow-store'
  )) as unknown as StoreModule
  return { q, ft, ws }
}

/**
 * Put the task row and the run journal into the exact state a live task is in
 * the instant the verify preflight gives up: `setup` and `code` both recorded
 * `'completed'`, `verify` recorded `'failed'`, the row `failed` with the
 * worktree-missing signature and stale pointers still attached.
 */
const stageResumedWorktreeMissing = async (
  q: QueueModule,
  ws: StoreModule,
  taskId: string,
  verifyAttempt: number,
): Promise<void> => {
  const store = ws.createQueueWorkflowStore()
  const now = Date.now()
  await store.createRun({
    id: taskId,
    workflowId: 'implement',
    inputJson: '{}',
    status: 'running',
    createdAt: now,
    updatedAt: now,
  })
  const step = (name: string, status: StepRecord['status'], attempt: number): StepRecord => ({
    runId: taskId,
    name,
    status,
    sha: null,
    startedAt: now,
    finishedAt: status === 'running' ? null : now,
    attempt,
    summary: null,
    errorSummary: null,
    transcriptKey: null,
    resultJson: null,
  })
  await store.putStep(step('setup', 'completed', 1))
  await store.putStep(step('code', 'completed', 1))
  await store.putStep(step('verify', 'failed', verifyAttempt))

  await q.updateTask(taskId, {
    status: 'failed',
    branch: `task/${taskId}`,
    worktreePath: `/tmp/absent/${taskId}`,
    claudeSessionId: 'stale-session',
    error: unrecoverableError(taskId),
    failedPhase: 'verify',
    failureReason: 'verify:worktree-missing',
    failureSignature: WORKTREE_MISSING_SIG,
    failureReasonCode: WORKTREE_MISSING_SIG,
  })
}

const failOnce = async (
  ft: FixTasksModule,
  taskId: string,
): Promise<Awaited<ReturnType<FixTasksModule['handleTaskFailureWithFixTask']>>> =>
  await ft.handleTaskFailureWithFixTask({
    taskId,
    failingStep: 'verify:worktree-missing',
    errorOutput: unrecoverableError(taskId),
  })

describe('environmental auto-restart for a missing worktree', () => {
  let repo: string

  beforeAll(async () => {
    templateRepo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = templateRepo
    const q = (await import('../../queue')) as unknown as QueueModule
    await q.migrateQueueSchema()
    const actionQueue = (await import('../action-queue')) as unknown as {
      initActionQueue: typeof import('../action-queue').initActionQueue
    }
    await actionQueue.initActionQueue()
    delete process.env.MARS_REPO
    const { closeAllDbs } = await import('../db')
    await closeAllDbs()
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(templateRepo, { recursive: true, force: true })
  })

  beforeEach(() => {
    repo = setupRepo()
    cloneTemplateDbs(repo)
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Defect 1: the remedy must restore its precondition ────────────────────
  it('discards the run journal so setup re-runs instead of the dispatch resuming straight into verify', async () => {
    const { q, ft, ws } = await loadModules(repo)
    const t = await q.enqueueTask('build the thing', undefined, { skipTriage: true })
    await stageResumedWorktreeMissing(q, ws, t.id, 4)

    const result = await failOnce(ft, t.id)
    expect(result.outcome).toBe('requeued')

    // The whole point: a re-queue that leaves `setup` recorded `'completed'`
    // short-circuits it on resume, so no worktree is ever rebuilt and verify
    // fails again on the same absent directory. The journal must be gone.
    const steps = await ws.createQueueWorkflowStore().listSteps(t.id)
    expect(steps).toHaveLength(0)
    const run = await ws.createQueueWorkflowStore().getRun(t.id)
    expect(run).toBeUndefined()
  })

  it('nulls the stale worktree pointers so setup carves a fresh worktree', async () => {
    const { q, ft, ws } = await loadModules(repo)
    const t = await q.enqueueTask('build the thing', undefined, { skipTriage: true })
    await stageResumedWorktreeMissing(q, ws, t.id, 4)

    await failOnce(ft, t.id)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
    expect(reloaded?.branch).toBeNull()
    expect(reloaded?.worktreePath).toBeNull()
    expect(reloaded?.claudeSessionId).toBeNull()
    // The failure markers are cleared too — a non-terminal row must never carry
    // a stale signature (the daemon-killed sweep keys off it).
    expect(reloaded?.failureSignature).toBeNull()
  })

  // ── Defect 2: the bound must actually bind ────────────────────────────────
  it('persists AND reads back envRestartCount so each restart is counted once', async () => {
    const { q, ft, ws } = await loadModules(repo)
    const t = await q.enqueueTask('build the thing', undefined, { skipTriage: true })

    await stageResumedWorktreeMissing(q, ws, t.id, 4)
    await failOnce(ft, t.id)
    expect((await q.getTask(t.id))?.envRestartCount).toBe(1)

    // The live bug: TASK_SEL omitted the column, so this second pass read the
    // counter as 0 again and re-wrote 1 — the reopen ledger recorded 35
    // consecutive "environmental restart #1" entries.
    await stageResumedWorktreeMissing(q, ws, t.id, 5)
    await failOnce(ft, t.id)
    expect((await q.getTask(t.id))?.envRestartCount).toBe(2)
  })

  it('escalates to the operator after a small bounded number of restarts instead of re-queueing forever', async () => {
    const { q, ft, ws } = await loadModules(repo)
    const cap = ft.MAX_ENV_RESTART_ATTEMPTS
    const t = await q.enqueueTask('build the thing', undefined, { skipTriage: true })

    // The environmental cap is the first bound; once it is spent the same
    // signature falls through to the non-code re-queue counter, which is the
    // second. Both must be finite: drive the identical failure until the
    // handler stops re-queueing, with a hard ceiling far below the 37 attempts
    // the live task reached.
    const HARD_CEILING = 15
    let attempts = 0
    let lastOutcome = ''
    while (attempts < HARD_CEILING) {
      await stageResumedWorktreeMissing(q, ws, t.id, 4 + attempts)
      const result = await failOnce(ft, t.id)
      attempts++
      lastOutcome = result.outcome
      if (result.outcome !== 'requeued') break
      expect((await q.getTask(t.id))?.status).toBe('queued')
    }

    expect(lastOutcome).not.toBe('requeued')
    expect(attempts).toBeLessThan(HARD_CEILING)
    // The environmental cap was genuinely consumed on the way — i.e. the
    // counter round-trips rather than resetting to 0 on every read.
    expect((await q.getTask(t.id))?.envRestartCount).toBe(cap)
    expect((await q.getTask(t.id))?.status).not.toBe('queued')
  })
})
