/**
 * Tests for the poll-fallback time-based re-queue ceiling (Fix 2, mars-c11be862).
 *
 * The ceiling prevents a re-queue loop from spinning indefinitely when a task
 * is stuck: if a task has been retrying beyond MARS_REQUEUE_MAX_RETRY_MS
 * wall-clock time, the task is escalated to 'failed' and an operator
 * action-queue item is raised instead of being re-seeded.
 *
 * A task at any number of attempts is NOT escalated while it is within the
 * time bound — including tasks whose attempt count exceeded the old hard
 * ceiling of 5. A fresh task with no step records is never escalated.
 *
 * Root cause of the 2026-07-02 overnight loop: tasks reached 1,014 step
 * attempts at ~2/min because the poll-fallback had no safety net to detect
 * genuine wedging vs. a slow but making-progress task.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { WorkflowStore, StepRecord } from '@mars/workflow'

// ──────────────────────────────────────────────────────────────────────────────
// Module-isolation helpers (vi.resetModules isolates singletons per test)
// ──────────────────────────────────────────────────────────────────────────────

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface WorkflowStoreModule {
  createQueueWorkflowStore: typeof import('../../../workflows/queue-workflow-store').createQueueWorkflowStore
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
}

interface CeilingModule {
  checkAndEscalateRequeueCeiling: (
    t: import('../../queue').Task,
    store: WorkflowStore,
    log: (msg: string) => void,
    nowMs?: number,
  ) => Promise<boolean>
  REQUEUE_MAX_RETRY_MS: number
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-ceiling-'))
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
  { maxRetryMs }: { maxRetryMs?: number } = {},
): Promise<{
  q: QueueModule
  ws: WorkflowStoreModule
  aq: ActionQueueModule
  ceiling: CeilingModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  if (maxRetryMs !== undefined) {
    process.env.MARS_REQUEUE_MAX_RETRY_MS = String(maxRetryMs)
  } else {
    delete process.env.MARS_REQUEUE_MAX_RETRY_MS
  }
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const ws = (await import(
    '../../../workflows/queue-workflow-store'
  )) as unknown as WorkflowStoreModule
  const aq = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const ceiling = (await import('../requeue-ceiling')) as unknown as CeilingModule
  return { q, ws, aq, ceiling }
}

const makeSilentLog = (): ((msg: string) => void) => () => {}

const makeCapturingLog = (): { log: (msg: string) => void; messages: string[] } => {
  const messages: string[] = []
  return { log: (msg: string) => { messages.push(msg) }, messages }
}

// Build a minimal StepRecord so tests don't have to spell out all fields.
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

describe('checkAndEscalateRequeueCeiling', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_REQUEUE_MAX_RETRY_MS
    rmSync(repo, { recursive: true, force: true })
  })

  // ── (a) Tasks beyond old attempt ceiling are re-seeded, not failed ─────────

  it('does NOT escalate a task whose attempt count exceeds the old ceiling of 5 while within the time bound', async () => {
    // This directly proves acceptance criterion (a): attempt count alone must
    // never cause a task to fail — only elapsed wall-clock time matters.
    const { q, ws, ceiling } = await loadModules(repo)
    // Default REQUEUE_MAX_RETRY_MS is 2 h; task just created → elapsed ≈ 0 ms.
    const t = await q.enqueueTask('high-attempt task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    // Attempt 10 — well above the old ceiling of 5.
    await store.putStep(makeStepRecord(t.id, 'setup-worktree', 10, 'failed'))

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
      Date.now(), // nowMs ≈ task.createdAt → elapsed ≈ 0 ms < 2 h bound
    )

    // Must NOT escalate — only the time bound counts, not the attempt count.
    expect(escalated).toBe(false)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  // ── (b) Retry count + elapsed time are surfaced ────────────────────────────

  it('logs attempt count and elapsed time for every retrying task', async () => {
    // Proves acceptance criterion (b): the operator can always see how many
    // times a task has been attempted and how long it has been retrying.
    const { q, ws } = await loadModules(repo)
    const t = await q.enqueueTask('retrying task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    // Load ceiling separately so REQUEUE_MAX_RETRY_MS is already resolved.
    const ceiling = (await import('../requeue-ceiling')) as unknown as CeilingModule

    const stepStartedAt = Date.now() - 5 * 60 * 1_000 // 5 minutes ago
    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(
      makeStepRecord(t.id, 'setup-worktree', 3, 'failed', stepStartedAt),
    )

    const { log, messages } = makeCapturingLog()
    await ceiling.checkAndEscalateRequeueCeiling(t, store, log, Date.now())

    // The log must mention the attempt count.
    expect(messages.some((m) => m.includes('attempt 3'))).toBe(true)
    // The log must mention elapsed time (in minutes).
    expect(messages.some((m) => /\d+m elapsed/.test(m))).toBe(true)
  })

  // ── (c) Time-based backstop escalates past the wall-clock bound ───────────

  it('escalates to failed and raises action-queue item when wall-clock bound is exceeded', async () => {
    // Proves acceptance criterion (c): the time-based backstop still catches
    // genuinely wedged tasks and prevents an infinite re-queue loop.
    //
    // Use MARS_REQUEUE_MAX_RETRY_MS=0 so any non-zero elapsed time exceeds
    // the bound — this makes the test independent of execution speed.
    const { q, ws, aq, ceiling } = await loadModules(repo, { maxRetryMs: 0 })
    const t = await q.enqueueTask('wedged task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(makeStepRecord(t.id, 'setup-worktree', 3, 'failed'))

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
      // nowMs well past any possible retryStartMs anchor so elapsedMs > 0
      Date.now() + 1,
    )

    // Returns true → caller must NOT re-seed.
    expect(escalated).toBe(true)

    // Task flipped to failed with time-bound failure code.
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReasonCode).toBe('requeue-time-bound-exceeded')
    expect(reloaded?.error).toMatch(/time bound/)

    // An open action-queue item was raised for this task.
    const items = await aq.listActionQueueItems('open')
    expect(items.some((i) => i.originTaskId === t.id && i.kind === 'failed')).toBe(true)
  })

  // ── No escalation within time bound ────────────────────────────────────────

  it('does not escalate when the task is within the time bound', async () => {
    const { q, ws, ceiling } = await loadModules(repo)
    const t = await q.enqueueTask('slow but healthy task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(makeStepRecord(t.id, 'code', 3, 'failed'))

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
      Date.now(), // elapsed ≈ 0 ms < 2 h default bound
    )
    expect(escalated).toBe(false)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  // ── Fresh task (no step records) is never escalated ────────────────────────

  it('does not escalate a task with no step records', async () => {
    // A task that has never been dispatched has no step records — it is not
    // in the re-queue cycle and must always be re-seeded normally.
    const { q, ws, ceiling } = await loadModules(repo, { maxRetryMs: 0 })
    const t = await q.enqueueTask('fresh task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    // No createRun / putStep calls.
    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
      Date.now(),
    )
    expect(escalated).toBe(false)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })
})
