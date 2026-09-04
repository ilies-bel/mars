/**
 * requeue-ceiling — sweep-eviction and operator-verb tests (mars-4d8ee9f5)
 *
 * Regression suite for the class of bugs where infrastructure re-queues
 * (stale-merging-sweep evictions) or operator verbs (mars remerge) were
 * incorrectly counted toward the per-task re-queue ceiling, causing tasks to
 * fail with `requeue:time-bound-exceeded` even though no coder-driven hot loop
 * occurred.
 *
 * Root cause (mars-e6344985, 2026-09-04): the stale-merging-sweep re-queued a
 * task from 'merging' back to 'queued' without resetting `requeueAnchorMs`.
 * Each eviction left the old step timestamps in place; the ceiling's elapsed
 * clock measured from the first coder step (48+ h ago) and tripped
 * immediately. `mars remerge` on the ceiling-tripped task failed on the same
 * ceiling before an operator retried it manually.
 *
 * Fix: phase-recovery.ts stamps `requeueAnchorMs: Date.now()` on every
 * infrastructure re-queue so elapsed time resets to zero. remerge-task.ts
 * also stamps it and returns `ceilingReset: true` when the prior failure
 * reason was `requeue:time-bound-exceeded`.
 *
 * These tests live beside the module (src/core/daemon/requeue-ceiling.test.ts)
 * so the verify command `npx vitest run src/core/daemon/requeue-ceiling.test.ts`
 * resolves them directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { WorkflowStore, StepRecord } from '@mars/workflow'

// ── Module-isolation helpers ──────────────────────────────────────────────────

interface QueueModule {
  enqueueTask: typeof import('../queue').enqueueTask
  getTask: typeof import('../queue').getTask
  updateTask: typeof import('../queue').updateTask
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
}

interface WorkflowStoreModule {
  createQueueWorkflowStore: typeof import('../../workflows/queue-workflow-store').createQueueWorkflowStore
}

interface CeilingModule {
  checkAndEscalateRequeueCeiling: (
    t: import('../queue').Task,
    store: WorkflowStore,
    log: (msg: string) => void,
    nowMs?: number,
    dispatchUptimeMs?: number,
  ) => Promise<boolean>
  REQUEUE_MAX_RETRY_MS: number
  REQUEUE_MAX_ATTEMPTS: number
}

interface RemergeModule {
  coreRemergeTask: typeof import('./remerge-task').coreRemergeTask
  RemergeTaskError: typeof import('./remerge-task').RemergeTaskError
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-ceiling-sweep-'))
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  }
  git('init', '--initial-branch=main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  writeFileSync(resolve(repo, 'README.md'), 'ceiling sweep fixture\n')
  git('add', 'README.md')
  git('commit', '-m', 'initial')
  return repo
}

const loadModules = async (
  repo: string,
  { maxRetryMs, maxAttempts }: { maxRetryMs?: number; maxAttempts?: number } = {},
) => {
  // Close all open PGlite connections from any prior module context BEFORE
  // resetting modules. Skipping this step leaves WASM memory orphaned and can
  // corrupt the next test's PGlite VFS with "could not open file" errors
  // (observed with coreRemergeTask's reopenTerminalTask path).
  try {
    const { closeAllDbs } = await import('../lib/db')
    await closeAllDbs()
  } catch {
    // No prior DB open (first test) or module already reset — safe to ignore.
  }
  vi.resetModules()
  process.env.MARS_REPO = repo
  if (maxRetryMs !== undefined) {
    process.env.MARS_REQUEUE_MAX_RETRY_MS = String(maxRetryMs)
  } else {
    delete process.env.MARS_REQUEUE_MAX_RETRY_MS
  }
  if (maxAttempts !== undefined) {
    process.env.MARS_REQUEUE_MAX_ATTEMPTS = String(maxAttempts)
  } else {
    delete process.env.MARS_REQUEUE_MAX_ATTEMPTS
  }
  const q = (await import('../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const ws = (await import(
    '../../workflows/queue-workflow-store'
  )) as unknown as WorkflowStoreModule
  const ceiling = (await import('./requeue-ceiling')) as unknown as CeilingModule
  const remerge = (await import('./remerge-task')) as unknown as RemergeModule
  return { q, ws, ceiling, remerge }
}

const makeSilentLog = (): ((msg: string) => void) => () => {}

const makeStepRecord = (
  runId: string,
  name: string,
  attempt: number,
  status: StepRecord['status'] = 'failed',
  startedAt: number = 0,
): StepRecord => ({
  runId,
  name,
  status,
  sha: null,
  startedAt,
  finishedAt: null,
  attempt,
  summary: null,
  errorSummary: null,
  transcriptKey: null,
  resultJson: null,
})

// ── Test suite ────────────────────────────────────────────────────────────────

describe('requeue-ceiling — sweep evictions and operator verbs', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_REQUEUE_MAX_RETRY_MS
    delete process.env.MARS_REQUEUE_MAX_ATTEMPTS
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Sweep eviction: requeueAnchorMs reset prevents immediate ceiling trip ──

  it('does NOT escalate when requeueAnchorMs was reset to now after a sweep eviction', async () => {
    // Scenario: a task has step records from 48 h ago (prior coder episode).
    // stale-merging-sweep re-queues it and stamps requeueAnchorMs = now.
    // On the next poll-fallback cycle the ceiling must NOT trip, because
    // elapsed from the anchor (just now) is ~0 ms — well inside the 2 h bound.
    const { q, ws, ceiling } = await loadModules(repo) // default 2 h bound

    const t = await q.enqueueTask('sweep-evicted task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    const fortyEightHoursAgoMs = Date.now() - 48 * 60 * 60 * 1_000
    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    // Three step attempts from 48 h ago — well over the elapsed bound.
    await store.putStep(makeStepRecord(t.id, 'setup-worktree', 3, 'failed', fortyEightHoursAgoMs))

    // Simulate stale-merging-sweep: re-queue the task AND reset the anchor to now.
    // This is what phase-recovery.ts now does (fix for mars-e6344985).
    const nowMs = Date.now()
    await q.updateTask(t.id, { status: 'queued', requeueAnchorMs: nowMs })
    const fresh = await q.getTask(t.id)

    // Poll-fallback runs 1 second later — elapsed from anchor = 1 s < 2 h bound.
    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      fresh!,
      store,
      makeSilentLog(),
      nowMs + 1_000, // 1 second after the sweep re-queue
    )

    expect(escalated).toBe(false)
    expect((await q.getTask(t.id))?.status).toBe('queued')
  })

  it('WOULD escalate without the anchor reset (control: proves the anchor matters)', async () => {
    // Same scenario but WITHOUT resetting requeueAnchorMs. The ceiling uses
    // step.startedAt = 48 h ago as its anchor → elapsed = 48 h >> 2 h bound.
    // This test is the counter-example that proves the anchor reset is load-bearing.
    const { q, ws, ceiling } = await loadModules(repo) // default 2 h bound

    const t = await q.enqueueTask('unanchored sweep task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    const fortyEightHoursAgoMs = Date.now() - 48 * 60 * 60 * 1_000
    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(makeStepRecord(t.id, 'setup-worktree', 3, 'failed', fortyEightHoursAgoMs))

    // Sweep re-queues WITHOUT resetting requeueAnchorMs (the old, buggy behaviour).
    await q.updateTask(t.id, { status: 'queued' }) // note: no requeueAnchorMs
    const fresh = await q.getTask(t.id)
    // requeueAnchorMs is null → ceiling falls back to MIN(step.startedAt) = 48h ago.

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      fresh!,
      store,
      makeSilentLog(),
      Date.now(), // nowMs ≈ now → elapsed from 48h-old anchor >> 2h bound
    )

    // The ceiling DOES fire without the anchor reset. This documents why the fix
    // is necessary — removing it from phase-recovery.ts would cause this test to
    // pass while the previous test would start failing.
    expect(escalated).toBe(true)
    expect((await q.getTask(t.id))?.status).toBe('failed')
    expect((await q.getTask(t.id))?.failureReason).toBe('requeue:time-bound-exceeded')
  })

  it('does NOT escalate after multiple sweep evictions when each one resets the anchor', async () => {
    // mars-e6344985 root cause: the task was evicted N times, each adding to
    // the elapsed counter. With requeueAnchorMs reset on each eviction, every
    // eviction restarts the elapsed window — accumulated eviction count is
    // irrelevant to the ceiling.
    const { q, ws, ceiling } = await loadModules(repo, { maxRetryMs: 1_000 }) // 1 s bound

    const t = await q.enqueueTask('multi-evicted task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    const longAgoMs = Date.now() - 10 * 60 * 1_000 // 10 min ago
    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(makeStepRecord(t.id, 'setup', 5, 'failed', longAgoMs))

    // Simulate three successive sweep evictions, each resetting the anchor.
    // After the THIRD one, the anchor is recent → elapsed < 1 s bound.
    const eviction1 = Date.now() - 600_000 // 10 min ago
    await q.updateTask(t.id, { status: 'queued', requeueAnchorMs: eviction1 })
    const eviction2 = Date.now() - 300_000 // 5 min ago
    await q.updateTask(t.id, { status: 'queued', requeueAnchorMs: eviction2 })
    const eviction3 = Date.now() - 100 // 100 ms ago (very recent)
    await q.updateTask(t.id, { status: 'queued', requeueAnchorMs: eviction3 })

    const fresh = await q.getTask(t.id)
    const nowMs = Date.now()

    // Poll-fallback fires immediately after the third eviction (elapsed = ~100 ms < 1 s).
    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      fresh!,
      store,
      makeSilentLog(),
      nowMs,
    )

    expect(escalated).toBe(false)
    expect((await q.getTask(t.id))?.status).toBe('queued')
  })

  // ── mars remerge: ceiling-tripped task is reset ───────────────────────────

  it('coreRemergeTask: ceiling-tripped task gets ceilingReset:true; unrelated failure does not', async () => {
    // Tests both the positive and negative ceilingReset cases in one loadModules
    // call. Running them together avoids a 5th vi.resetModules() cycle, which
    // corrupts the file-backed PGlite WASM state on this test machine.
    //
    // Positive case: a task failed with requeue:time-bound-exceeded.
    // The operator runs `mars remerge`. The result must say ceilingReset:true
    // and the task must have requeueAnchorMs set to a recent time so the
    // ceiling does not fire again immediately.
    //
    // Negative case: a task failed with an unrelated reason. coreRemergeTask
    // must succeed but must NOT set ceilingReset.
    const { q, ws, ceiling, remerge } = await loadModules(repo)

    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
    }

    // ── Positive case: ceiling-tripped task ─────────────────────────────────
    const tCeiling = await q.enqueueTask('ceiling-tripped task', undefined, { skipTriage: true })
    const storeCeiling: WorkflowStore = ws.createQueueWorkflowStore()

    // Create a git branch with at least one commit ahead of main.
    const branchCeiling = `task/${tCeiling.id}`
    git('checkout', '-b', branchCeiling)
    writeFileSync(resolve(repo, 'work-ceiling.txt'), 'task work\n')
    git('add', 'work-ceiling.txt')
    git('commit', '-m', 'task work ceiling')
    git('checkout', 'main')

    await q.updateTask(tCeiling.id, {
      status: 'failed',
      branch: branchCeiling,
      worktreePath: null,
      failureReason: 'requeue:time-bound-exceeded',
      failureReasonCode: 'requeue-retry-churn',
      error: 'Re-queue ceiling exceeded',
      requeueAnchorMs: Date.now() - 10 * 60 * 60 * 1_000, // 10 h ago (stale)
    })
    await storeCeiling.createRun({
      id: tCeiling.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })

    process.env.MARS_REPO = repo
    const beforeRemergeMs = Date.now()
    const resultCeiling = await remerge.coreRemergeTask(tCeiling.id, new Set(['failed']), storeCeiling)

    expect(resultCeiling.status).toBe('queued')
    expect(resultCeiling.ceilingReset).toBe(true)

    const afterCeiling = await q.getTask(tCeiling.id)
    expect(afterCeiling?.status).toBe('queued')
    expect(afterCeiling?.requeueAnchorMs).toBeDefined()
    expect(afterCeiling!.requeueAnchorMs!).toBeGreaterThanOrEqual(beforeRemergeMs)

    // Ceiling must NOT fire immediately after the remerge re-queue.
    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      afterCeiling!,
      storeCeiling,
      makeSilentLog(),
      Date.now() + 1_000,
    )
    expect(escalated).toBe(false)

    // ── Negative case: unrelated failure ────────────────────────────────────
    const tOther = await q.enqueueTask('non-ceiling-failed task', undefined, { skipTriage: true })
    const storeOther: WorkflowStore = ws.createQueueWorkflowStore()

    const branchOther = `task/${tOther.id}`
    git('checkout', '-b', branchOther)
    writeFileSync(resolve(repo, `work-other-${tOther.id}.txt`), 'task work\n')
    git('add', '.')
    git('commit', '-m', 'task work other')
    git('checkout', 'main')

    await q.updateTask(tOther.id, {
      status: 'failed',
      branch: branchOther,
      worktreePath: null,
      failureReason: 'verify:test-failure',
    })
    await storeOther.createRun({
      id: tOther.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })

    const resultOther = await remerge.coreRemergeTask(tOther.id, new Set(['failed']), storeOther)

    expect(resultOther.status).toBe('queued')
    expect(resultOther.ceilingReset).toBeUndefined()
  })
})
