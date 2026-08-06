/**
 * Unit / integration tests for runReflectRecommendedDetector.
 *
 * Each test gets a fresh git repo + `.mars/` state dir so module-level
 * singletons are reset between tests (via vi.resetModules inside loadContext).
 *
 * ## Store seam
 *
 * The detector READS through the store handed to it via `opts.store` but WRITES
 * through `action-queue.ts`'s module-level `stateClient()` (=
 * `resolveStateClient()`), which it cannot be handed. In production those are
 * the same object: `resolveStateClient()` and `resolveQueueClient()` both call
 * `openDb(resolveDbTarget())`, and `openDb` keys one client per target per
 * process. A test therefore only observes the detector's writes if it seeds and
 * asserts through that same resolver.
 *
 * Two things break that, and this suite used to do both:
 *
 *  1. Opening a bespoke client for `file:<repo>/.mars/mars.db`. Under
 *     `MARS_DB_BACKEND=pglite` `openDb` keys on the target string, so
 *     `pglite:<repo>/.mars/mars.db` is a *different* in-memory database from
 *     the `pglite:<repo>/.mars` every production resolver opens. Assertions
 *     then counted rows in an empty DB and silently saw 0.
 *  2. Importing the client factory at the top of the file. `openDb`'s registry
 *     is module-scoped, so a client built from the pre-`vi.resetModules()`
 *     module graph lands in a different registry than the one the module under
 *     test uses — a different PGlite instance even for an identical target.
 *
 * So: everything DB-related is imported *inside* `loadContext`, after
 * `vi.resetModules()`, and the store wraps `resolveStateClient()`. No hand-
 * rolled DDL either — `openDb` bootstraps the canonical schema on first use.
 *
 * Acceptance criteria verified here:
 *  1. Detector fires on KPI drift when autoTrigger=false → raises row
 *  2. Detector fires on ≥3 tasks sharing a failure signature → raises row
 *  3. Detector fires on any task with token spend ≥2× window median → raises row
 *  4. autoTrigger=true → no row raised (returns raised=false)
 *  5. At most one open row per window (dedup: second call with same condition bumps seen_count, not new row)
 *  6. Condition no longer holds → open row is closed (level-trigger off)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { DomainTaskStore as TaskStore } from '../../store/task-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-rrd-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

interface TestContext {
  runReflectRecommendedDetector: typeof import('../self-evolve-trigger.js')['runReflectRecommendedDetector']
  store: TaskStore
  countOpenReflectRows: () => Promise<number>
  countResolvedReflectRows: () => Promise<number>
}

const loadContext = async (repo: string): Promise<TestContext> => {
  vi.resetModules()
  process.env.MARS_REPO = repo

  // Imported here, not at the top of the file: see the "Store seam" note in the
  // header. These must come from the post-reset module graph so the test shares
  // `openDb`'s client registry with the module under test.
  const { resolveStateClient } = await import('../../store/state-client.js')
  const { createTaskStore } = await import('../../store/task-store.js')

  // The very client `action-queue.ts` writes through. `openDb` applies the
  // canonical schema on first use, so no fixture DDL is needed (and none may be
  // added: a hand-rolled `CREATE TABLE IF NOT EXISTS` would silently no-op
  // against the real schema and give a false sense of control over the shape).
  const store = createTaskStore(resolveStateClient())

  const { runReflectRecommendedDetector } = await import('../self-evolve-trigger.js')

  const countOpenReflectRows = async (): Promise<number> => {
    const r = await store.query({
      sql: `SELECT COUNT(*) as n FROM action_queue_items WHERE kind = 'reflect-recommended' AND state = 'open'`,
      args: [],
    })
    const row = r.rows[0] as unknown as { n: number }
    return row.n
  }

  const countResolvedReflectRows = async (): Promise<number> => {
    const r = await store.query({
      sql: `SELECT COUNT(*) as n FROM action_queue_items WHERE kind = 'reflect-recommended' AND state = 'resolved'`,
      args: [],
    })
    const row = r.rows[0] as unknown as { n: number }
    return row.n
  }

  return { runReflectRecommendedDetector, store, countOpenReflectRows, countResolvedReflectRows }
}

const insertSnapshot = async (
  store: TaskStore,
  opts: {
    id: string
    takenAt: string
    failureRate: number
    failureRateLowConfidence?: 0 | 1
  },
): Promise<void> => {
  const frConf = opts.failureRateLowConfidence ?? 0
  await store.execute({
    sql: `INSERT INTO kpi_snapshots
            (id, taken_at, window_start, window_end,
             cost_per_arc_sample_count, cost_per_arc_low_confidence,
             failure_rate_sample_count, failure_rate_low_confidence,
             autonomous_completion_rate_sample_count, autonomous_completion_rate_low_confidence,
             recovery_success_rate_sample_count, recovery_success_rate_low_confidence,
             cost_per_arc_p50, cost_per_arc_p90,
             failure_rate, autonomous_completion_rate, recovery_success_rate)
          VALUES (?, ?, ?, ?, 0, 1, ?, ?, 0, 1, 0, 1, NULL, NULL, ?, NULL, NULL)`,
    args: [
      opts.id,
      opts.takenAt,
      opts.takenAt,
      opts.takenAt,
      frConf === 0 ? 10 : 2,
      frConf,
      opts.failureRate,
    ],
  })
}

const insertFailedTask = async (
  store: TaskStore,
  id: string,
  failureSignature: string,
  createdAt = new Date().toISOString(),
): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO tasks (id, prompt, status, failure_signature, created_at, updated_at)
          VALUES (?, ?, 'failed', ?, ?, ?)`,
    args: [id, `task ${id}`, failureSignature, createdAt, createdAt],
  })
}

const insertStepEndedEvent = async (
  store: TaskStore,
  taskId: string,
  inputTokens: number,
  outputTokens: number,
  timestamp = new Date().toISOString(),
): Promise<void> => {
  const payload = JSON.stringify({
    stepName: 'code',
    usageSignals: {
      inputTokens,
      outputTokens,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      messageCount: 1,
    },
  })
  // `trace_events.id` is `text PRIMARY KEY` with no default — the canonical
  // schema expects the writer to mint it.
  await store.execute({
    sql: `INSERT INTO trace_events (id, kind, task_id, timestamp, payload)
          VALUES (?, 'step_ended', ?, ?, ?)`,
    args: [randomUUID(), taskId, Date.parse(timestamp), payload],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runReflectRecommendedDetector', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER
    rmSync(repo, { recursive: true, force: true })
  })

  // Acceptance criterion 1: KPI drift fires the detector
  it('raises a reflect-recommended row when KPI drift is detected and autoTrigger is off', async () => {
    const ctx = await loadContext(repo)

    // prior: failure_rate=0.10, current: 0.25 → +150% drift (well above 10% threshold)
    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
      failureRate: 0.25,
    })

    const result = await ctx.runReflectRecommendedDetector({ store: ctx.store })

    expect(result.raised).toBe(true)
    expect(result.rowId).not.toBeNull()
    expect(result.evidence?.kpiDrift.length).toBeGreaterThan(0)
    expect(result.evidence?.kpiDrift[0]?.kpi).toBe('failure_rate')

    // Exactly one open row in the DB
    expect(await ctx.countOpenReflectRows()).toBe(1)
  })

  // Acceptance criterion 2: failure signature cluster fires the detector
  it('raises a row when ≥3 recent tasks share a failure signature', async () => {
    const ctx = await loadContext(repo)

    // No KPI snapshots so KPI drift cannot fire
    // Insert 3 tasks with the same failure signature
    await insertFailedTask(ctx.store, 'task-1', 'code/timeout')
    await insertFailedTask(ctx.store, 'task-2', 'code/timeout')
    await insertFailedTask(ctx.store, 'task-3', 'code/timeout')

    const result = await ctx.runReflectRecommendedDetector({ store: ctx.store })

    expect(result.raised).toBe(true)
    expect(result.evidence?.failureClusters.length).toBeGreaterThan(0)
    expect(result.evidence?.failureClusters[0]?.signature).toBe('code/timeout')
    expect(result.evidence?.failureClusters[0]?.count).toBeGreaterThanOrEqual(3)

    expect(await ctx.countOpenReflectRows()).toBe(1)
  })

  // Acceptance criterion 3: token spike fires the detector
  it('raises a row when a task has token spend ≥2× the window median', async () => {
    const ctx = await loadContext(repo)

    // 4 tasks: most modest, one outlier at 4× the median
    await insertStepEndedEvent(ctx.store, 'task-a', 1000, 500)  // ~1050 weighted
    await insertStepEndedEvent(ctx.store, 'task-b', 1000, 500)  // ~1050 weighted
    await insertStepEndedEvent(ctx.store, 'task-c', 1000, 500)  // ~1050 weighted
    await insertStepEndedEvent(ctx.store, 'task-d', 8000, 4000) // ~12000 weighted (>2× median)

    const result = await ctx.runReflectRecommendedDetector({ store: ctx.store })

    expect(result.raised).toBe(true)
    expect(result.evidence?.tokenSpike).not.toBeNull()
    expect(result.evidence?.tokenSpike?.taskId).toBe('task-d')
    expect(result.evidence?.tokenSpike?.multipleOfMedian).toBeGreaterThanOrEqual(2)

    expect(await ctx.countOpenReflectRows()).toBe(1)
  })

  // Acceptance criterion 4: autoTrigger=true → no row raised
  it('does not raise a row when autoTrigger is true', async () => {
    process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER = 'true'
    const ctx = await loadContext(repo)

    // Insert significant KPI drift so detector would fire if autoTrigger=false
    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
      failureRate: 0.25,
    })

    const result = await ctx.runReflectRecommendedDetector({ store: ctx.store })

    expect(result.raised).toBe(false)
    expect(result.rowId).toBeNull()
    expect(await ctx.countOpenReflectRows()).toBe(0)
  })

  // Acceptance criterion 5: dedup — at most one open row per window
  it('bumps the existing open row rather than creating a second one (dedup)', async () => {
    const ctx = await loadContext(repo)

    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
      failureRate: 0.25,
    })

    // First call → raises row
    const first = await ctx.runReflectRecommendedDetector({ store: ctx.store })
    expect(first.raised).toBe(true)
    expect(await ctx.countOpenReflectRows()).toBe(1)

    // Second call with the same condition → bumps existing, still only one row
    const second = await ctx.runReflectRecommendedDetector({ store: ctx.store })
    expect(second.raised).toBe(true)
    expect(second.rowId).toBe(first.rowId)
    expect(await ctx.countOpenReflectRows()).toBe(1)
  })

  // Acceptance criterion 6: condition gone → open row is closed
  it('closes the open row when the condition no longer holds', async () => {
    const ctx = await loadContext(repo)

    // First: insert 3 same-signature failures → row raised
    await insertFailedTask(ctx.store, 'task-x1', 'code/oom')
    await insertFailedTask(ctx.store, 'task-x2', 'code/oom')
    await insertFailedTask(ctx.store, 'task-x3', 'code/oom')

    const first = await ctx.runReflectRecommendedDetector({ store: ctx.store })
    expect(first.raised).toBe(true)
    expect(await ctx.countOpenReflectRows()).toBe(1)

    // Second: make the condition lapse the way it lapses in production — the
    // cluster ages out of the detector's rolling window. (Flipping the tasks to
    // 'done' instead would be rejected by the tasks_reject_terminal_transition
    // trigger: terminal states are absorbing, so 'failed' tasks never become
    // 'done' without a task_terminal_reopens grant.)
    const wayBack = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
    await ctx.store.execute({
      sql: `UPDATE tasks SET created_at = ? WHERE failure_signature = 'code/oom'`,
      args: [wayBack],
    })

    // No KPI snapshots exist either, so all detectors should be quiet.
    const second = await ctx.runReflectRecommendedDetector({ store: ctx.store })
    expect(second.raised).toBe(false)

    // Open row should now be resolved
    expect(await ctx.countOpenReflectRows()).toBe(0)
    expect(await ctx.countResolvedReflectRows()).toBe(1)
  })

  // No row when no signals fire and autoTrigger=false
  it('returns raised=false and no row when no signals fire', async () => {
    const ctx = await loadContext(repo)
    // No data inserted — all detectors quiet

    const result = await ctx.runReflectRecommendedDetector({ store: ctx.store })

    expect(result.raised).toBe(false)
    expect(result.rowId).toBeNull()
    expect(await ctx.countOpenReflectRows()).toBe(0)
  })

  // Diagnostic skip reasons
  it("returns skipReason='no-evidence' when no signals fire and autoTrigger is off", async () => {
    const ctx = await loadContext(repo)
    // No data inserted — all detectors quiet

    const result = await ctx.runReflectRecommendedDetector({ store: ctx.store })

    expect(result.raised).toBe(false)
    expect(result.skipReason).toBe('no-evidence')
  })

  it("returns skipReason='auto-trigger-on' when autoTrigger is on even with evidence present", async () => {
    process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER = 'true'
    const ctx = await loadContext(repo)

    // Insert KPI drift that would normally fire the detector
    await insertSnapshot(ctx.store, {
      id: 'snap-prior',
      takenAt: '2026-01-01T00:00:00Z',
      failureRate: 0.10,
    })
    await insertSnapshot(ctx.store, {
      id: 'snap-current',
      takenAt: '2026-01-02T00:00:00Z',
      failureRate: 0.25,
    })

    const result = await ctx.runReflectRecommendedDetector({ store: ctx.store })

    expect(result.raised).toBe(false)
    expect(result.skipReason).toBe('auto-trigger-on')
  })

  it('returns skipReason=null when a row is raised', async () => {
    const ctx = await loadContext(repo)

    // Insert failure cluster that fires the detector
    await insertFailedTask(ctx.store, 'task-s1', 'verify/timeout')
    await insertFailedTask(ctx.store, 'task-s2', 'verify/timeout')
    await insertFailedTask(ctx.store, 'task-s3', 'verify/timeout')

    const result = await ctx.runReflectRecommendedDetector({ store: ctx.store })

    expect(result.raised).toBe(true)
    expect(result.skipReason).toBeNull()
  })
})
