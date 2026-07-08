/**
 * Spend meter tests (lib/spend-meter.ts).
 *
 * Covers the PRD's acceptance surface:
 *  - the rolling-window sum matches cacheWeightedTokens() over fixture
 *    events, with NO task join / status filter (in-flight arcs count);
 *  - a step_ended event WITHOUT usageSignals (a provider-rejected 429 call)
 *    contributes nothing;
 *  - the 'budget-window' row raises at threshold, bumps seen_count on
 *    re-detection, holds in the 90–100% hysteresis dead zone, and
 *    auto-resolves below 90% of threshold;
 *  - a 'budget-arc:<arcId>' row raises per offending live arc and
 *    auto-resolves when the arc reaches terminal status;
 *  - absent config = disabled = no rows.
 *
 * Same fixture pattern as action-queue.test.ts (temp repo + MARS_REPO +
 * vi.resetModules so the state-client singleton and context cache rebind)
 * and kpi-compute.test.ts (minimal tasks/trace_events DDL). Tasks,
 * trace_events, and action_queue_items all live in the same mars.db file
 * (ADR-0034), so the sweep's raise/resolve calls hit the same database the
 * fixture store writes to.
 */

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheWeightedTokens, type ClaudeUsage } from '../kpi-compute.js'

type SpendMeterModule = typeof import('../spend-meter')
type ActionQueueModule = typeof import('../action-queue')
type TaskStoreModule = typeof import('../../store/task-store')
type LibsqlModule = typeof import('../libsql')

interface Fixture {
  spendMeter: SpendMeterModule
  actionQueue: ActionQueueModule
  store: import('../../store/task-store').DomainTaskStore
}

const TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT,
    status TEXT NOT NULL,
    origin_id TEXT,
    fix_for_task_id TEXT,
    updated_at TEXT NOT NULL
  )
`

const TRACE_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS trace_events (
    id        TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    kind      TEXT NOT NULL,
    severity  TEXT NOT NULL DEFAULT 'info',
    task_id   TEXT,
    origin_id TEXT,
    phase     TEXT,
    payload   TEXT NOT NULL DEFAULT '{}'
  )
`

let repo: string

const loadFixture = async (): Promise<Fixture> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const spendMeter = (await import('../spend-meter')) as SpendMeterModule
  const actionQueue = (await import('../action-queue')) as ActionQueueModule
  const { createTaskStore } = (await import('../../store/task-store')) as TaskStoreModule
  const { openLibsql } = (await import('../libsql')) as LibsqlModule
  const client = openLibsql({ url: `file:${resolve(repo, '.mars', 'mars.db')}` })
  await client.execute(TASKS_DDL)
  await client.execute(TRACE_EVENTS_DDL)
  const store = createTaskStore(client)
  return { spendMeter, actionQueue, store }
}

const insertTask = async (
  store: Fixture['store'],
  opts: { id: string; status: string; origin_id?: string | null },
): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO tasks (id, prompt, status, origin_id, fix_for_task_id, updated_at)
          VALUES (?, NULL, ?, ?, NULL, ?)`,
    args: [opts.id, opts.status, opts.origin_id ?? null, new Date().toISOString()],
  })
}

const setTaskStatus = async (
  store: Fixture['store'],
  id: string,
  status: string,
): Promise<void> => {
  await store.execute({
    sql: `UPDATE tasks SET status = ? WHERE id = ?`,
    args: [status, id],
  })
}

const insertStepEnded = async (
  store: Fixture['store'],
  opts: {
    taskId: string
    originId?: string | null
    timestamp?: string
    usage?: ClaudeUsage
  },
): Promise<string> => {
  const id = randomUUID()
  const payload: Record<string, unknown> = { stepName: 'code' }
  if (opts.usage) {
    payload.usageSignals = { ...opts.usage, messageCount: 1 }
  }
  await store.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, task_id, origin_id, payload)
          VALUES (?, ?, 'step_ended', ?, ?, ?)`,
    args: [
      id,
      opts.timestamp ?? new Date().toISOString(),
      opts.taskId,
      opts.originId ?? null,
      JSON.stringify(payload),
    ],
  })
  return id
}

const deleteEvent = async (store: Fixture['store'], id: string): Promise<void> => {
  await store.execute({ sql: `DELETE FROM trace_events WHERE id = ?`, args: [id] })
}

const minutesAgo = (n: number): string =>
  new Date(Date.now() - n * 60_000).toISOString()

beforeEach(() => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-spend-meter-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
})

afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Window sum — cacheWeightedTokens parity, no status filter, 429 exclusion
// ---------------------------------------------------------------------------

describe('computeWindowSpend', () => {
  it('matches cacheWeightedTokens() over fixture events, counting in-flight arcs', async () => {
    const { spendMeter, store } = await loadFixture()

    // One in-flight arc and one done arc — the window sum has NO tasks
    // join and NO status filter, so both count.
    await insertTask(store, { id: 'arc-running', status: 'running' })
    await insertTask(store, { id: 'arc-done', status: 'done' })

    const usages: ClaudeUsage[] = [
      { inputTokens: 1_000, outputTokens: 2_000, cacheCreateTokens: 500, cacheReadTokens: 10_000 },
      { inputTokens: 42, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 7 },
    ]
    await insertStepEnded(store, { taskId: 'arc-running', usage: usages[0], timestamp: minutesAgo(5) })
    await insertStepEnded(store, { taskId: 'arc-done', usage: usages[1], timestamp: minutesAgo(10) })
    // Outside the window — must not count.
    await insertStepEnded(store, {
      taskId: 'arc-done',
      usage: { inputTokens: 999_999, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
      timestamp: minutesAgo(120),
    })

    const spend = await spendMeter.computeWindowSpend(store, { sinceIso: minutesAgo(60) })

    const expected = usages.reduce((sum, u) => sum + cacheWeightedTokens(u), 0)
    expect(spend).toBeCloseTo(expected, 6)
    // Cache reads at 0.1x: sanity-pin the weighting itself.
    expect(cacheWeightedTokens(usages[0]!)).toBe(1_000 + 2_000 + 500 + 10_000 * 0.1)
  })

  it('a step_ended event without usageSignals (429-rejected call) does NOT count', async () => {
    const { spendMeter, store } = await loadFixture()
    await insertTask(store, { id: 'arc-a', status: 'running' })

    const counted: ClaudeUsage = {
      inputTokens: 100, outputTokens: 50, cacheCreateTokens: 0, cacheReadTokens: 0,
    }
    await insertStepEnded(store, { taskId: 'arc-a', usage: counted, timestamp: minutesAgo(1) })
    // Provider-rejected call: step_ended with no usageSignals payload at all.
    await insertStepEnded(store, { taskId: 'arc-a', timestamp: minutesAgo(1) })

    const spend = await spendMeter.computeWindowSpend(store, { sinceIso: minutesAgo(60) })
    expect(spend).toBeCloseTo(cacheWeightedTokens(counted), 6)
  })
})

// ---------------------------------------------------------------------------
// Sweep — window row lifecycle (raise, seen_count bump, hysteresis, resolve)
// ---------------------------------------------------------------------------

describe('runSpendSweep — budget-window row', () => {
  it('raises at threshold, bumps seen_count on re-detection, holds in the hysteresis zone, resolves below 90%', async () => {
    const { spendMeter, actionQueue, store } = await loadFixture()
    spendMeter.writeBudgetConfig({ windowMs: 60 * 60_000, windowTokens: 1_000 })
    const state = spendMeter.createSpendSweepState()

    await insertTask(store, { id: 'arc-a', status: 'running' })
    // 1_200 weighted tokens inside the window: over the 1_000 threshold.
    const overEvent = await insertStepEnded(store, {
      taskId: 'arc-a',
      usage: { inputTokens: 1_200, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
      timestamp: minutesAgo(2),
    })

    const first = await spendMeter.runSpendSweep({ surface: store, state })
    expect(first.windowEnabled).toBe(true)
    expect(first.raised).toHaveLength(1)

    let open = await actionQueue.listActionQueueItems('open', { kind: 'budget-window' })
    expect(open).toHaveLength(1)
    expect(open[0]!.signature).toBe('budget-window')
    expect(open[0]!.seenCount).toBe(1)
    expect(open[0]!.payload.spendTokens).toBe(1_200)

    // Re-detection: same singleton row, seen_count bumps, no sibling.
    await spendMeter.runSpendSweep({ surface: store, state })
    open = await actionQueue.listActionQueueItems('open', { kind: 'budget-window' })
    expect(open).toHaveLength(1)
    expect(open[0]!.seenCount).toBe(2)

    // Hysteresis dead zone: 950 is below the threshold but above 90% of it
    // (900) — the row must stay open and nothing new is raised.
    await deleteEvent(store, overEvent)
    await insertStepEnded(store, {
      taskId: 'arc-a',
      usage: { inputTokens: 950, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
      timestamp: minutesAgo(2),
    })
    const dead = await spendMeter.runSpendSweep({ surface: store, state })
    expect(dead.raised).toHaveLength(0)
    expect(dead.resolved).toHaveLength(0)
    open = await actionQueue.listActionQueueItems('open', { kind: 'budget-window' })
    expect(open).toHaveLength(1)

    // Spend ages out below 90% of threshold: the sweep auto-resolves the row.
    await store.execute(`DELETE FROM trace_events`)
    await insertStepEnded(store, {
      taskId: 'arc-a',
      usage: { inputTokens: 500, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
      timestamp: minutesAgo(2),
    })
    const clearing = await spendMeter.runSpendSweep({ surface: store, state })
    expect(clearing.resolved).toHaveLength(1)
    open = await actionQueue.listActionQueueItems('open', { kind: 'budget-window' })
    expect(open).toHaveLength(0)
    const all = await actionQueue.listActionQueueItems('all', { kind: 'budget-window' })
    expect(all).toHaveLength(1)
    expect(all[0]!.state).toBe('resolved')
  })
})

// ---------------------------------------------------------------------------
// Sweep — per-arc row lifecycle (raise per arc, resolve on terminal)
// ---------------------------------------------------------------------------

describe('runSpendSweep — budget-arc rows', () => {
  it('raises one row per offending live arc and resolves it when the arc goes terminal', async () => {
    const { spendMeter, actionQueue, store } = await loadFixture()
    spendMeter.writeBudgetConfig({ arcTokens: 500 })
    const state = spendMeter.createSpendSweepState()

    // Arc A: origin + member task, lifetime spend 600 (over the 500 ceiling).
    await insertTask(store, { id: 'arc-a', status: 'running' })
    await insertTask(store, { id: 'a-member', status: 'running', origin_id: 'arc-a' })
    await insertStepEnded(store, {
      taskId: 'a-member',
      originId: 'arc-a',
      usage: { inputTokens: 600, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
      timestamp: minutesAgo(3),
    })
    // Arc B: single live task, spend 700 — its own row.
    await insertTask(store, { id: 'arc-b', status: 'running' })
    await insertStepEnded(store, {
      taskId: 'arc-b',
      usage: { inputTokens: 700, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
      timestamp: minutesAgo(3),
    })
    // Arc C: live but under the ceiling — no row.
    await insertTask(store, { id: 'arc-c', status: 'running' })
    await insertStepEnded(store, {
      taskId: 'arc-c',
      usage: { inputTokens: 100, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
      timestamp: minutesAgo(3),
    })

    const first = await spendMeter.runSpendSweep({ surface: store, state })
    expect(first.arcEnabled).toBe(true)
    let open = await actionQueue.listActionQueueItems('open', { kind: 'budget-arc' })
    const signatures = open.map((i) => i.signature).sort()
    expect(signatures).toEqual(['budget-arc:arc-a', 'budget-arc:arc-b'])

    // Arc A reaches terminal status (every task in the arc): the sweep is
    // the resolver — its row auto-resolves; arc B's row stays open.
    await setTaskStatus(store, 'arc-a', 'done')
    await setTaskStatus(store, 'a-member', 'done')
    const second = await spendMeter.runSpendSweep({ surface: store, state })
    expect(second.resolved).toHaveLength(1)
    open = await actionQueue.listActionQueueItems('open', { kind: 'budget-arc' })
    expect(open.map((i) => i.signature)).toEqual(['budget-arc:arc-b'])
  })
})

// ---------------------------------------------------------------------------
// Absent config = disabled = no rows
// ---------------------------------------------------------------------------

describe('runSpendSweep — unconfigured', () => {
  it('absent config means both meters are disabled and no rows are raised', async () => {
    const { spendMeter, actionQueue, store } = await loadFixture()
    const state = spendMeter.createSpendSweepState()

    await insertTask(store, { id: 'arc-a', status: 'running' })
    await insertStepEnded(store, {
      taskId: 'arc-a',
      usage: {
        inputTokens: 10_000_000, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0,
      },
      timestamp: minutesAgo(1),
    })

    const report = await spendMeter.runSpendSweep({ surface: store, state })
    expect(report.windowEnabled).toBe(false)
    expect(report.arcEnabled).toBe(false)
    expect(report.raised).toHaveLength(0)
    expect(report.windowSpendTokens).toBeNull()

    const open = await actionQueue.listActionQueueItems('open')
    expect(open.filter((i) => i.kind === 'budget-window' || i.kind === 'budget-arc')).toHaveLength(0)

    expect(spendMeter.readBudgetConfig()).toBeNull()
  })

  it('computeBudgetStatus reports configured:false with null sections (never fake zeros)', async () => {
    const { spendMeter, store } = await loadFixture()
    const status = await spendMeter.computeBudgetStatus(store)
    expect(status.configured).toBe(false)
    expect(status.config).toBeNull()
    expect(status.window).toBeNull()
    expect(status.arcs).toBeNull()
    expect(status.openRows).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Config round-trip
// ---------------------------------------------------------------------------

describe('budget config', () => {
  it('merge-patches subsets and preserves unnamed thresholds', async () => {
    const { spendMeter } = await loadFixture()
    spendMeter.writeBudgetConfig({ windowMs: 4 * 3_600_000, windowTokens: 5_000_000 })
    spendMeter.writeBudgetConfig({ arcTokens: 750_000 })
    expect(spendMeter.readBudgetConfig()).toEqual({
      windowMs: 4 * 3_600_000,
      windowTokens: 5_000_000,
      arcTokens: 750_000,
    })
  })

  it('rejects non-positive thresholds', async () => {
    const { spendMeter } = await loadFixture()
    expect(() => spendMeter.writeBudgetConfig({ windowTokens: 0 })).toThrow()
    expect(() => spendMeter.writeBudgetConfig({ arcTokens: -5 })).toThrow()
  })

  it('parses durations to milliseconds', async () => {
    const { spendMeter } = await loadFixture()
    expect(spendMeter.parseDurationToMs('4h')).toBe(4 * 3_600_000)
    expect(spendMeter.parseDurationToMs('30m')).toBe(30 * 60_000)
    expect(spendMeter.parseDurationToMs('90s')).toBe(90_000)
    expect(spendMeter.parseDurationToMs('500ms')).toBe(500)
    expect(spendMeter.parseDurationToMs('250')).toBe(250)
    expect(() => spendMeter.parseDurationToMs('abc')).toThrow()
    expect(() => spendMeter.parseDurationToMs('0h')).toThrow()
  })
})
