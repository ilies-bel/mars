/**
 * Tests for the poll-fallback time-based re-queue ceiling (Fix 2, mars-c11be862).
 *
 * The ceiling prevents a re-queue loop from spinning indefinitely when a task
 * is stuck: if a task has been retrying beyond MARS_REQUEUE_MAX_RETRY_MS
 * wall-clock time, the task is escalated to 'failed' and an operator
 * action-queue item is raised instead of being re-seeded.
 *
 * A task is NOT escalated while it is within BOTH bounds — including tasks
 * whose attempt count exceeded the old hard ceiling of 5. A fresh task with no
 * step records is never escalated.
 *
 * The attempt bound (MARS_REQUEUE_MAX_ATTEMPTS, default 12) is the second,
 * peer bound: time alone cannot catch a hot loop, which burns attempts far
 * faster than dispatch uptime (mars-6cf9774f reached verify attempt 37 in 35
 * minutes, under a third of the 2 h time bound). It is deliberately set well
 * above the old hard ceiling of 5 so a slow-but-progressing task is unaffected.
 *
 * Root cause of the 2026-07-02 overnight loop: tasks reached 1,014 step
 * attempts at ~2/min because the poll-fallback had no safety net to detect
 * genuine wedging vs. a slow but making-progress task.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { WorkflowStore, StepRecord } from '@mars/workflow'

// ──────────────────────────────────────────────────────────────────────────────
// Module-isolation helpers (vi.resetModules isolates singletons per test)
// ──────────────────────────────────────────────────────────────────────────────

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  updateTask: typeof import('../../queue').updateTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
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
    dispatchUptimeMs?: number,
  ) => Promise<boolean>
  REQUEUE_MAX_RETRY_MS: number
  REQUEUE_MAX_ATTEMPTS: number
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-ceiling-'))
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  // `coreContinueTask` refreshes the task worktree from the integration branch
  // (`git merge --no-edit main`), so a bare temp directory is no longer a
  // sufficient fixture — it fails with "not a git repository". Initialise a
  // real repo on `main` with one commit so the refresh is a no-op merge.
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  }
  git('init', '--initial-branch=main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  writeFileSync(resolve(repo, 'README.md'), 'ceiling fixture\n')
  git('add', 'README.md')
  git('commit', '-m', 'initial')
  return repo
}

const loadModules = async (
  repo: string,
  { maxRetryMs, maxAttempts }: { maxRetryMs?: number; maxAttempts?: number } = {},
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
  if (maxAttempts !== undefined) {
    process.env.MARS_REQUEUE_MAX_ATTEMPTS = String(maxAttempts)
  } else {
    delete process.env.MARS_REQUEUE_MAX_ATTEMPTS
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

// Build a minimal WorkflowStore mock that returns a fixed steps list.
// Only listSteps is exercised by checkAndEscalateRequeueCeiling.
const makeMockStore = (steps: StepRecord[]): WorkflowStore =>
  ({ listSteps: async (_runId: string) => steps }) as unknown as WorkflowStore

// Insert an outbox event row with a controlled ts (seconds since epoch).
// Follows the same pattern as requeue-diagnostics.test.ts.
const insertEvent = async (
  q: QueueModule,
  type: string,
  taskId: string,
  tsSec: number,
): Promise<void> => {
  const payload =
    type === 'task.blocked'
      ? JSON.stringify({ taskId, fixTaskId: null, failureSignature: '', failingStep: '' })
      : JSON.stringify({ taskId })
  await q.resolveQueueClient().execute({
    sql: `INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)`,
    args: [type, payload, tsSec],
  })
}

describe('checkAndEscalateRequeueCeiling', () => {
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

  // ── Attempt bound: the backstop for a HOT loop ─────────────────────────────

  it('escalates a task whose attempt count reaches the attempt bound even when it is nowhere near the time bound', async () => {
    // mars-6cf9774f reached verify attempt 37 in 35 minutes — under a third of
    // the 2 h dispatch-uptime bound — so the time bound never fired. A re-queue
    // cycle that has re-run the same step this many times is not making
    // progress, whatever the clock says.
    const { q, ws, ceiling } = await loadModules(repo, { maxAttempts: 6 })
    const t = await q.enqueueTask('hot-looping task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(makeStepRecord(t.id, 'setup', 1, 'completed'))
    await store.putStep(makeStepRecord(t.id, 'verify', 6, 'failed'))

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
      Date.now(), // elapsed ≈ 0 ms — far inside the default 2 h time bound
    )

    expect(escalated).toBe(true)
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    // The identity field stays the stable step id so both bounds share one
    // signature; the attempt/time distinction lives in the prose only.
    expect(reloaded?.failureReason).toBe('requeue:time-bound-exceeded')
    expect(reloaded?.error).toContain('attempt bound')
  })

  it('does not escalate on attempts alone while below the attempt bound', async () => {
    const { q, ws, ceiling } = await loadModules(repo, { maxAttempts: 6 })
    const t = await q.enqueueTask('slow but progressing', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(makeStepRecord(t.id, 'verify', 5, 'failed'))

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
      Date.now(),
    )

    expect(escalated).toBe(false)
    expect((await q.getTask(t.id))?.status).toBe('queued')
  })

  // ── (a) Tasks beyond old attempt ceiling are re-seeded, not failed ─────────

  it('does NOT escalate a task whose attempt count exceeds the old ceiling of 5 while within the time bound', async () => {
    // This directly proves acceptance criterion (a): the old hard ceiling of 5
    // attempts must not fail a task. The attempt bound that DOES exist is
    // MARS_REQUEUE_MAX_ATTEMPTS (default 12), comfortably above attempt 10.
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

  it('does not escalate after a pause lasting ten times the bound', async () => {
    const { q, ceiling } = await loadModules(repo, { maxRetryMs: 100 })
    const task = await q.enqueueTask('paused task', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      recoverySpawnedCount: 1,
      requeueDispatchUptimeMs: 1_000,
    })
    const fresh = await q.getTask(task.id)
    const store = makeMockStore([
      makeStepRecord(task.id, 'code', 1, 'failed', 1_000),
    ])

    // A live daemon dispatched for 10ms, then remained paused for 1,000ms
    // (10× the bound) before resuming. Its persisted uptime counter remains
    // at 1,010, so the ceiling sees only the 10 eligible milliseconds.
    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      fresh!,
      store,
      makeSilentLog(),
      2_010,
      1_010,
    )

    expect(escalated).toBe(false)
    expect((await q.getTask(task.id))?.status).toBe('queued')
  })

  it('escalates a dense retry loop during continuous dispatch uptime as retry-churn', async () => {
    const { q, ceiling } = await loadModules(repo, { maxRetryMs: 100 })
    const task = await q.enqueueTask('hot loop task', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      recoverySpawnedCount: 5,
      requeueDispatchUptimeMs: 1_000,
    })
    const fresh = await q.getTask(task.id)
    const store = makeMockStore([
      makeStepRecord(task.id, 'code', 5, 'failed', 1_000),
    ])

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      fresh!,
      store,
      makeSilentLog(),
      1_200,
      1_200,
    )

    expect(escalated).toBe(true)
    expect((await q.getTask(task.id))?.failureReasonCode).toBe('requeue-retry-churn')
  })

  it('never classifies a one-retry task as retry-churn despite a large elapsed span', async () => {
    const { q, ceiling } = await loadModules(repo, { maxRetryMs: 100 })
    const task = await q.enqueueTask('sparse retry task', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      recoverySpawnedCount: 1,
      requeueDispatchUptimeMs: 1_000,
    })
    const fresh = await q.getTask(task.id)
    const store = makeMockStore([
      makeStepRecord(task.id, 'code', 5, 'failed', 1_000),
    ])

    await ceiling.checkAndEscalateRequeueCeiling(
      fresh!,
      store,
      makeSilentLog(),
      2_000,
      2_000,
    )

    expect((await q.getTask(task.id))?.failureReasonCode).not.toBe('requeue-retry-churn')
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
    expect(messages.some((m) => /\d+m dispatch uptime elapsed/.test(m))).toBe(true)
  })

  // ── (c) Time-based backstop escalates past the wall-clock bound ───────────

  it('escalates to failed and raises action-queue item when wall-clock bound is exceeded', async () => {
    // Proves acceptance criterion (c): the time-based backstop still catches
    // genuinely wedged tasks and prevents an infinite re-queue loop.
    //
    // Use MARS_REQUEUE_MAX_RETRY_MS=0 so any non-zero elapsed time exceeds
    // the bound — this makes the test independent of execution speed.
    //
    // The fixture (attempt=3, startedAt=0) produces density=3/min ≥ 1,
    // so the breach is classified as 'retry-churn'.
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
    await q.updateTask(t.id, { recoverySpawnedCount: 3 })
    const retrying = await q.getTask(t.id)

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      retrying!,
      store,
      makeSilentLog(),
      // nowMs well past any possible retryStartMs anchor so elapsedMs > 0
      Date.now() + 1,
    )

    // Returns true → caller must NOT re-seed.
    expect(escalated).toBe(true)

    // Task flipped to failed with retry-churn failure code.
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReasonCode).toBe('requeue-retry-churn')
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

  // ── failureReason is a stable step id (not prose with elapsed time) ────────

  it('sets failureReason to the stable step id requeue:time-bound-exceeded so two failures with different elapsed minutes share one signature', async () => {
    // Regression test for the live defect: the old prose reason included
    // elapsed minutes, minting a distinct signature for every occurrence
    // ("Re-queue time bound exceeded: 1 attempt(s) over 270m …" ≠
    //  "Re-queue time bound exceeded: 1 attempt(s) over 271m …").
    // After the fix, failureReason is the step id and the measurements
    // live only in the `error` field and the action-queue body.
    const { q, ws, ceiling } = await loadModules(repo, { maxRetryMs: 0 })
    const t = await q.enqueueTask('ceiling signature task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(makeStepRecord(t.id, 'setup-worktree', 1, 'failed'))

    await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
      Date.now() + 1,
    )

    const reloaded = await q.getTask(t.id)
    // Must be the step-id grammar value, not elapsed-time prose.
    expect(reloaded?.failureReason).toBe('requeue:time-bound-exceeded')
    // The human-readable detail belongs in `error`, not `failureReason`.
    expect(reloaded?.error).toMatch(/time(?: bound| retried)/)
  })

  // ── requeueAnchorMs: mars continue re-anchor overrides old step timestamps ──

  it('does NOT escalate a task whose journal has 48h-old steps when requeueAnchorMs anchors to now', async () => {
    // This is the exact failure scenario from the mars-c8a8a02d bug report:
    // `mars continue` re-queues a task but the journal has steps started 48h ago.
    // The ceiling MUST use requeueAnchorMs (set by `mars continue`) as the
    // anchor, not MIN(step.startedAt) — otherwise it fires immediately and
    // the task is failed before the coder even gets a chance to run.
    const { q, ws, ceiling } = await loadModules(repo)
    const t = await q.enqueueTask('old-journal continued task', undefined, { skipTriage: true })
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
    // Steps from 48h ago — these would normally trigger ceiling escalation.
    await store.putStep(
      makeStepRecord(t.id, 'setup-worktree', 2, 'failed', fortyEightHoursAgoMs),
    )
    await store.putStep(
      makeStepRecord(t.id, 'run-claude-code', 3, 'failed', fortyEightHoursAgoMs + 5_000),
    )

    // Simulate `mars continue`: set requeueAnchorMs to now (re-queue episode started just now).
    const nowMs = Date.now()
    await q.updateTask(t.id, { status: 'queued', requeueAnchorMs: nowMs })
    const fresh = await q.getTask(t.id)

    // With default 2h bound, elapsed from requeueAnchorMs ≈ 0 ms — well within the bound.
    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      fresh!,
      store,
      makeSilentLog(),
      nowMs + 1_000, // 1 second after the anchor
    )

    // Must NOT escalate — anchor is the continue time, not the 48h-old step.
    expect(escalated).toBe(false)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('still escalates a continued task that then loops beyond the time bound', async () => {
    // After `mars continue`, if the resumed task spins in its own hot loop for
    // longer than REQUEUE_MAX_RETRY_MS, the ceiling must still fire.
    // MARS_REQUEUE_MAX_RETRY_MS=0 so any elapsed time past requeueAnchorMs fails.
    const { q, ws, ceiling } = await loadModules(repo, { maxRetryMs: 0 })
    const t = await q.enqueueTask('continued but stuck task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(makeStepRecord(t.id, 'setup-worktree', 1, 'failed', Date.now()))

    // Simulate `mars continue`: anchor is set to some past time (e.g., 5 seconds ago).
    const anchorMs = Date.now() - 5_000
    await q.updateTask(t.id, { status: 'queued', requeueAnchorMs: anchorMs })
    const fresh = await q.getTask(t.id)

    // With maxRetryMs=0 any elapsed > 0 exceeds the bound.
    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      fresh!,
      store,
      makeSilentLog(),
      anchorMs + 1, // 1 ms after the anchor → elapsed = 1 ms > 0 ms bound
    )

    expect(escalated).toBe(true)
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    // One retry cannot be retry churn, even where a single step has a dense
    // timestamp window.
    expect(reloaded?.failureReasonCode).toBe('requeue-queue-starvation')
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

  // ── Early warning at pre-ceiling threshold ───────────────────────────────

  it('raises a low-priority requeue-warning when elapsed reaches WARN_RATIO of the bound without escalating the task', async () => {
    const { q, ws, aq, ceiling } = await loadModules(repo, { maxRetryMs: 100 })
    const t = await q.enqueueTask('approaching-ceiling task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    const anchorMs = 1_000_000
    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(makeStepRecord(t.id, 'setup-worktree', 2, 'failed', anchorMs))

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
      anchorMs + 90, // 90% of 100 ms bound → above 80% WARN_RATIO threshold
    )

    expect(escalated).toBe(false)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')

    const items = await aq.listActionQueueItems('open')
    const warning = items.find(
      (i) => i.signature === `requeue-warning:${t.id}`,
    )
    expect(warning).toBeDefined()
    expect(warning?.kind).toBe('requeue-warning')
    expect(warning?.priority).toBe('low')
    expect(warning?.title).toContain('approaching requeue ceiling')
  })

  it('does NOT raise a warning when elapsed is below the WARN_RATIO threshold', async () => {
    const { q, ws, aq, ceiling } = await loadModules(repo, { maxRetryMs: 100 })
    const t = await q.enqueueTask('healthy-ish task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    const anchorMs = 1_000_000
    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(makeStepRecord(t.id, 'setup-worktree', 2, 'failed', anchorMs))

    await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
      anchorMs + 50, // 50% of bound — below 80% threshold
    )

    const items = await aq.listActionQueueItems('open')
    const warning = items.find(
      (i) => i.signature === `requeue-warning:${t.id}`,
    )
    expect(warning).toBeUndefined()
  })

  // ── Class-specific escalation tests ────────────────────────────────────────
  //
  // Each test constructs a representative StepRecord[] fixture for one breach
  // class and asserts the resulting failureReasonCode and payload.diagnostics.
  // A mock WorkflowStore is used so step arrays can be crafted freely (the real
  // store's upsert-on-conflict constraint allows only one record per step name
  // per run, making multi-timestamp spans impossible to construct).

  it('emits requeue-retry-churn code for a high-density hot loop', async () => {
    // Fixture: attempt=5, startedAt=0 → spanMs=0 → density=5/1=5 ≥ 1/min.
    const { q, aq, ceiling } = await loadModules(repo, { maxRetryMs: 0 })
    const t = await q.enqueueTask('churn task', undefined, { skipTriage: true })
    await q.updateTask(t.id, { recoverySpawnedCount: 5 })
    const retrying = await q.getTask(t.id)
    const steps = [makeStepRecord('run-1', 'code', 5, 'failed', 0)]
    const store = makeMockStore(steps)

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      retrying!,
      store,
      makeSilentLog(),
      Date.now() + 1,
    )
    expect(escalated).toBe(true)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.failureReasonCode).toBe('requeue-retry-churn')

    const items = await aq.listActionQueueItems('open')
    const item = items.find((i) => i.originTaskId === t.id)
    expect(item).toBeDefined()
    expect(item?.payload).toMatchObject({
      diagnostics: {
        class: 'retry-churn',
        maxAttempt: 5,
        queuedNeighbourCount: 0,
      },
    })
    expect(item?.title).toContain('retry-churn')
  })

  it('emits requeue-blocked-wait code when the majority of elapsed time was blocked', async () => {
    // Fixture: 2 sparse attempts over 10 min (density≈0.22 < 1); blocked for
    // 6 min out of 10 min elapsed (60% > 50% threshold).
    const nowMs = 2_000_000_000
    const { q, aq, ceiling } = await loadModules(repo, { maxRetryMs: 0 })
    const t = await q.enqueueTask('blocked task', undefined, { skipTriage: true })

    // Two records with the same step name and valid timestamps spread 9 minutes
    // apart — gives density = 2/9 ≈ 0.22/min < 1 → not retry-churn.
    const steps = [
      makeStepRecord('run-1', 'code', 2, 'failed', nowMs - 10 * 60_000),
      makeStepRecord('run-2', 'code', 2, 'failed', nowMs - 1 * 60_000),
    ]
    const store = makeMockStore(steps)

    // Insert blocked-wait events: blocked at (nowMs - 7 min), unblocked at
    // (nowMs - 1 min) → 6 min = 360_000 ms blocked.
    const blockedTsSec = (nowMs - 7 * 60_000) / 1_000
    const unblockTsSec = (nowMs - 1 * 60_000) / 1_000
    await insertEvent(q, 'task.blocked', t.id, blockedTsSec)
    await insertEvent(q, 'task.queued', t.id, unblockTsSec)

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
      nowMs,
    )
    expect(escalated).toBe(true)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.failureReasonCode).toBe('requeue-blocked-wait')

    const items = await aq.listActionQueueItems('open')
    const item = items.find((i) => i.originTaskId === t.id)
    expect(item).toBeDefined()
    expect(item?.payload).toMatchObject({
      diagnostics: {
        class: 'blocked-wait',
        maxAttempt: 2,
        queuedNeighbourCount: 0,
      },
    })
    // blockedWaitMs should be approximately 360_000ms (6 minutes).
    const diag = item?.payload?.diagnostics as Record<string, unknown> | undefined
    expect(Number(diag?.blockedWaitMs)).toBeGreaterThan(0)
    expect(item?.title).toContain('blocked-wait')
  })

  it('emits requeue-queue-starvation code for few sparse attempts with no blocked wait', async () => {
    // Fixture: 2 attempts over 10 min (density≈0.22 < 1), no blocked events,
    // attemptCount ≤ 2 → queue-starvation.
    const nowMs = 2_000_000_000
    const { q, aq, ceiling } = await loadModules(repo, { maxRetryMs: 0 })
    const t = await q.enqueueTask('starved task', undefined, { skipTriage: true })

    const steps = [
      makeStepRecord('run-1', 'code', 2, 'failed', nowMs - 10 * 60_000),
      makeStepRecord('run-2', 'code', 2, 'failed', nowMs - 1 * 60_000),
    ]
    const store = makeMockStore(steps)
    // No blocked events → blockedWaitMs = 0.

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
      nowMs,
    )
    expect(escalated).toBe(true)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.failureReasonCode).toBe('requeue-queue-starvation')

    const items = await aq.listActionQueueItems('open')
    const item = items.find((i) => i.originTaskId === t.id)
    expect(item).toBeDefined()
    expect(item?.payload).toMatchObject({
      diagnostics: {
        class: 'queue-starvation',
        maxAttempt: 2,
        blockedWaitMs: 0,
        queuedNeighbourCount: 0,
      },
    })
    expect(item?.title).toContain('queue-starvation')
  })

  it('emits requeue-long-running code for many slow attempts with no excess blocking', async () => {
    // Fixture: 5 attempts over 3 hours — density = 5/90 ≈ 0.056/min < 1,
    // attemptCount > 2, no blocked events → long-running.
    const nowMs = 2_000_000_000
    const { q, aq, ceiling } = await loadModules(repo, { maxRetryMs: 0 })
    const t = await q.enqueueTask('long-running task', undefined, { skipTriage: true })

    const steps = [
      makeStepRecord('run-1', 'code', 5, 'failed', nowMs - 180 * 60_000),
      makeStepRecord('run-2', 'code', 5, 'failed', nowMs - 90 * 60_000),
    ]
    const store = makeMockStore(steps)
    // No blocked events → blockedWaitMs = 0.

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
      nowMs,
    )
    expect(escalated).toBe(true)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.failureReasonCode).toBe('requeue-long-running')

    const items = await aq.listActionQueueItems('open')
    const item = items.find((i) => i.originTaskId === t.id)
    expect(item).toBeDefined()
    expect(item?.payload).toMatchObject({
      diagnostics: {
        class: 'long-running',
        maxAttempt: 5,
        blockedWaitMs: 0,
        queuedNeighbourCount: 0,
      },
    })
    expect(item?.title).toContain('long-running')
  })

  // ── Integration: coreContinueTask + ceiling — full chain ───────────────────

  it('integration: coreContinueTask sets requeueAnchorMs so the ceiling does not immediately fire after resuming a task with a 48h-old journal', async () => {
    // The mars-c8a8a02d failure scenario, end-to-end:
    //   1. A task failed with steps recorded 48h ago (journal preserved for
    //      checkpoint-resume — the entire point of `mars continue`).
    //   2. The operator runs `mars continue` (→ coreContinueTask).
    //   3. On the next poll cycle the ceiling runs (→ checkAndEscalateRequeueCeiling).
    //   4. The task must still be 'queued' — NOT failed immediately.
    //
    // This test drives coreContinueTask directly (unlike the "requeueAnchorMs
    // anchors to now" test above, which manually sets the field) to prove the
    // full operator → ceiling chain works end-to-end.
    const { q, ws, ceiling } = await loadModules(repo)
    // Import continue-task in the same module-reset context so it shares the DB.
    const { coreContinueTask } = (await import('../continue-task')) as {
      coreContinueTask: (id: string) => Promise<{ degradedToRestart: boolean; coderResume?: boolean; note?: string }>
    }

    const t = await q.enqueueTask('48h-old failed task', undefined, { skipTriage: true })

    // Simulate a task that failed in the verify phase with its worktree still
    // on disk. Use `repo` as the worktree path — existsSync(repo) returns true.
    await q.updateTask(t.id, {
      status: 'failed',
      error: 'verify timed out 48 hours ago',
      failedPhase: 'verify',
      branch: `task/${t.id}`,
      worktreePath: repo,
    })

    // Create the workflow run with steps whose startedAt is 48h in the past.
    // Without requeueAnchorMs this would cause immediate ceiling escalation.
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
    await store.putStep(
      makeStepRecord(t.id, 'setup-worktree', 2, 'failed', fortyEightHoursAgoMs),
    )

    // ── mars continue ────────────────────────────────────────────────────────
    const beforeContinueMs = Date.now()
    const result = await coreContinueTask(t.id)
    expect(result.degradedToRestart).toBe(false)

    const afterContinue = await q.getTask(t.id)
    expect(afterContinue?.status).toBe('queued')
    // coreContinueTask must stamp requeueAnchorMs with the re-queue instant.
    expect(afterContinue?.requeueAnchorMs).toBeDefined()
    expect(afterContinue?.requeueAnchorMs!).toBeGreaterThanOrEqual(beforeContinueMs)

    // ── Poll-fallback ceiling check (next cycle, immediately after continue) ─
    const nowMs = Date.now()
    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      afterContinue!,
      store,
      makeSilentLog(),
      nowMs, // wall-clock ≈ requeueAnchorMs → elapsed ≈ 0 ms < 2h bound
    )

    // Must NOT escalate: the anchor is the continue timestamp (just now), not
    // the 48h-old step.startedAt values preserved in the checkpoint journal.
    expect(escalated).toBe(false)
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  // ── Quota-rejected attempts do not count toward the ceiling ───────────────

  it('does not escalate when all step attempts were provider quota-rejected', async () => {
    // Scenario: the Codex (or Claude) provider hit a rate/spend limit.  Every
    // dispatch of this task ends immediately with a quota rejection — the coder
    // never ran, the worktree is untouched.  The quota path in the code step
    // re-queues the task AND increments quotaRejectedAttempts by 1 each time so
    // the ceiling can discount them.  With 13 quota-rejected attempts and an
    // attempt bound of 12, the ceiling MUST still pass (effectiveAttempts = 0).
    const { q, ws, ceiling } = await loadModules(repo, { maxAttempts: 12 })
    const t = await q.enqueueTask('quota-rejected task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    // 13 step records from repeated quota rejections (attempt bound = 12).
    await store.putStep(makeStepRecord(t.id, 'code', 13, 'failed'))

    // Mark all 13 as quota-rejected so the ceiling excludes them.
    await q.updateTask(t.id, { quotaRejectedAttempts: 13 })
    const fresh = await q.getTask(t.id)

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      fresh!,
      store,
      makeSilentLog(),
      Date.now(),
    )

    // Must NOT escalate — effectiveAttempts = 13 - 13 = 0 (not in re-queue cycle).
    expect(escalated).toBe(false)
    expect((await q.getTask(t.id))?.status).toBe('queued')
  })

  it('escalates on non-quota attempts even when some attempts were quota-rejected', async () => {
    // 8 total attempts, 4 quota-rejected → 4 effective real attempts.
    // With attempt bound = 4, effectiveAttempts = 4 → escalate.
    const { q, ceiling } = await loadModules(repo, { maxAttempts: 4 })
    const t = await q.enqueueTask('mixed-rejection task', undefined, { skipTriage: true })
    const steps = [makeStepRecord(t.id, 'code', 8, 'failed')]
    const store = makeMockStore(steps)

    await q.updateTask(t.id, { quotaRejectedAttempts: 4 })
    const fresh = await q.getTask(t.id)

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      fresh!,
      store,
      makeSilentLog(),
      Date.now() + 1,
    )

    // 8 total - 4 quota-rejected = 4 effective attempts ≥ bound → escalate.
    expect(escalated).toBe(true)
    expect((await q.getTask(t.id))?.status).toBe('failed')
  })
})
