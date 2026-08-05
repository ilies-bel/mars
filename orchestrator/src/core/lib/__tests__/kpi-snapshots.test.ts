import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openLibsql } from '../libsql.js'
import { createTaskStore, type DomainTaskStore as TaskStore } from '../../store/task-store.js'
import { takeKpiSnapshot, readLatestKpiSnapshot, readKpiWindowComparison, readKpiSeries } from '../kpi-snapshots.js'

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

const TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    origin_id TEXT,
    fix_for_task_id TEXT,
    updated_at TEXT NOT NULL
  )
`

const ACTION_QUEUE_ITEMS_DDL = `
  CREATE TABLE IF NOT EXISTS action_queue_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    origin_task_id TEXT
  )
`

const KPI_SNAPSHOTS_DDL = `
  CREATE TABLE IF NOT EXISTS kpi_snapshots (
    id TEXT PRIMARY KEY,
    taken_at TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    cost_per_arc_sample_count INTEGER NOT NULL,
    cost_per_arc_low_confidence INTEGER NOT NULL,
    failure_rate_sample_count INTEGER NOT NULL,
    failure_rate_low_confidence INTEGER NOT NULL,
    autonomous_completion_rate_sample_count INTEGER NOT NULL,
    autonomous_completion_rate_low_confidence INTEGER NOT NULL,
    recovery_success_rate_sample_count INTEGER NOT NULL,
    recovery_success_rate_low_confidence INTEGER NOT NULL,
    cost_per_arc_p50 REAL,
    cost_per_arc_p90 REAL,
    failure_rate REAL,
    autonomous_completion_rate REAL,
    recovery_success_rate REAL
  )
`

const TRACE_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS trace_events (
    id        TEXT PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    kind      TEXT NOT NULL,
    severity  TEXT NOT NULL DEFAULT 'info',
    task_id   TEXT,
    origin_id TEXT,
    phase     TEXT,
    payload   TEXT NOT NULL DEFAULT '{}'
  )
`

const makeStore = async (): Promise<TaskStore> => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-kpi-snapshots-'))
  const client = openLibsql({ url: `file:${join(dir, 'queue.db')}` })
  await client.execute(TASKS_DDL)
  await client.execute(ACTION_QUEUE_ITEMS_DDL)
  await client.execute(KPI_SNAPSHOTS_DDL)
  await client.execute(TRACE_EVENTS_DDL)
  return createTaskStore(client)
}

const insertSignal = async (
  store: TaskStore,
  opts: {
    taskId: string
    inputTokens?: number
    outputTokens?: number
    cacheCreateTokens?: number
    cacheReadTokens?: number
  },
): Promise<void> => {
  const payload = JSON.stringify({
    stepName: 'code',
    usageSignals: {
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
      cacheCreateTokens: opts.cacheCreateTokens ?? 0,
      cacheReadTokens: opts.cacheReadTokens ?? 0,
      messageCount: 1,
    },
  })
  await store.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, task_id, payload)
          VALUES (?, ?, 'step_ended', ?, ?)`,
    args: [randomUUID(), Date.parse('2026-01-04T12:00:01Z'), opts.taskId, payload],
  })
}

const insertTask = async (
  store: TaskStore,
  opts: { id: string; status: string; fix_for_task_id?: string | null; updated_at?: string },
): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO tasks (id, prompt, status, origin_id, fix_for_task_id, created_at, updated_at)
          VALUES (?, '', ?, NULL, ?, ?, ?)`,
    args: [
      opts.id,
      opts.status,
      opts.fix_for_task_id ?? null,
      opts.updated_at ?? '2026-01-04T12:00:00Z',
      opts.updated_at ?? '2026-01-04T12:00:00Z',
    ],
  })
}

const NOW = '2026-01-07T12:00:00Z'

const insertSnapshot = async (
  store: TaskStore,
  s: {
    id: string
    taken_at: string
    window_start: string
    window_end: string
    failure_rate_sample_count?: number
    failure_rate_low_confidence?: number
    cost_per_arc_sample_count?: number
    cost_per_arc_low_confidence?: number
    autonomous_completion_rate_sample_count?: number
    autonomous_completion_rate_low_confidence?: number
    recovery_success_rate_sample_count?: number
    recovery_success_rate_low_confidence?: number
    failure_rate?: number | null
    cost_per_arc_p50?: number | null
    cost_per_arc_p90?: number | null
    autonomous_completion_rate?: number | null
    recovery_success_rate?: number | null
  },
): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO kpi_snapshots (
            id, taken_at, window_start, window_end,
            cost_per_arc_sample_count, cost_per_arc_low_confidence,
            failure_rate_sample_count, failure_rate_low_confidence,
            autonomous_completion_rate_sample_count, autonomous_completion_rate_low_confidence,
            recovery_success_rate_sample_count, recovery_success_rate_low_confidence,
            cost_per_arc_p50, cost_per_arc_p90,
            failure_rate, autonomous_completion_rate, recovery_success_rate
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      s.id,
      s.taken_at,
      s.window_start,
      s.window_end,
      s.cost_per_arc_sample_count ?? 0,
      s.cost_per_arc_low_confidence ?? 0,
      s.failure_rate_sample_count ?? 0,
      s.failure_rate_low_confidence ?? 0,
      s.autonomous_completion_rate_sample_count ?? 0,
      s.autonomous_completion_rate_low_confidence ?? 0,
      s.recovery_success_rate_sample_count ?? 0,
      s.recovery_success_rate_low_confidence ?? 0,
      s.cost_per_arc_p50 ?? null,
      s.cost_per_arc_p90 ?? null,
      s.failure_rate ?? null,
      s.autonomous_completion_rate ?? null,
      s.recovery_success_rate ?? null,
    ],
  })
}

// ---------------------------------------------------------------------------
// 1. Basic snapshot insertion and retrieval
// ---------------------------------------------------------------------------

describe('takeKpiSnapshot + readLatestKpiSnapshot — basic round-trip', () => {
  it('inserts exactly one row and readLatestKpiSnapshot returns it', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 't1', status: 'done' })
    await insertTask(store, { id: 't2', status: 'done' })
    await insertTask(store, { id: 't3', status: 'failed' })

    const written = await takeKpiSnapshot({ surface: store, now: NOW })
    const read = await readLatestKpiSnapshot(store)

    expect(written).not.toBeNull()
    expect(read).not.toBeNull()
    expect(read!.id).toBe(written!.id)
    expect(read!.taken_at).toBe(NOW)
  })

  it('readLatestKpiSnapshot returns null when no snapshot has been taken', async () => {
    const store = await makeStore()
    const result = await readLatestKpiSnapshot(store)
    expect(result).toBeNull()
  })

  it('readLatestKpiSnapshot returns the most recently taken snapshot', async () => {
    const store = await makeStore()
    // A task is required so sample_count > 0 and both takeKpiSnapshot calls write a row.
    await insertTask(store, { id: 't-series', status: 'done' })
    const first = await takeKpiSnapshot({
      surface: store,
      now: '2026-01-06T00:00:00Z',
    })
    const second = await takeKpiSnapshot({
      surface: store,
      now: '2026-01-07T00:00:00Z',
    })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    const latest = await readLatestKpiSnapshot(store)
    expect(latest!.id).toBe(second!.id)
    expect(latest!.id).not.toBe(first!.id)
  })
})

// ---------------------------------------------------------------------------
// 2. Failure rate is correctly persisted
// ---------------------------------------------------------------------------

describe('takeKpiSnapshot — failure_rate column', () => {
  it('sets failure_rate = failed / (done + failed)', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 't1', status: 'done' })
    await insertTask(store, { id: 't2', status: 'done' })
    await insertTask(store, { id: 't3', status: 'failed' })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    // 1 failed / 3 total = 0.333...
    expect(snapshot).not.toBeNull()
    expect(snapshot!.failure_rate).not.toBeNull()
    expect(snapshot!.failure_rate!).toBeCloseTo(1 / 3, 5)
    expect(snapshot!.failure_rate_sample_count).toBe(3)
  })

  it('returns null (skips write) when no arcs are in the window', async () => {
    const store = await makeStore()
    // No tasks → all four KPI sample counts are 0 → guard returns null without writing

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot).toBeNull()
    // Confirm no row was written
    const latest = await readLatestKpiSnapshot(store)
    expect(latest).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. low_confidence flag at the sample floor boundary
// ---------------------------------------------------------------------------

describe('takeKpiSnapshot — low_confidence flag', () => {
  it('sets failure_rate_low_confidence=1 when failure_rate_sample_count < sampleFloor (default 5)', async () => {
    const store = await makeStore()
    // 4 tasks — just below the default floor of 5
    await insertTask(store, { id: 't1', status: 'done' })
    await insertTask(store, { id: 't2', status: 'done' })
    await insertTask(store, { id: 't3', status: 'done' })
    await insertTask(store, { id: 't4', status: 'done' })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot!.failure_rate_low_confidence).toBe(1)
    expect(snapshot!.failure_rate_sample_count).toBe(4)
  })

  it('sets failure_rate_low_confidence=0 when failure_rate_sample_count equals sampleFloor', async () => {
    const store = await makeStore()
    // Exactly 5 tasks — exactly at the default floor
    await insertTask(store, { id: 't1', status: 'done' })
    await insertTask(store, { id: 't2', status: 'done' })
    await insertTask(store, { id: 't3', status: 'done' })
    await insertTask(store, { id: 't4', status: 'done' })
    await insertTask(store, { id: 't5', status: 'done' })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot!.failure_rate_low_confidence).toBe(0)
    expect(snapshot!.failure_rate_sample_count).toBe(5)
  })

  it('sets failure_rate_low_confidence=0 when failure_rate_sample_count > sampleFloor', async () => {
    const store = await makeStore()
    // 6 tasks — above the default floor
    await insertTask(store, { id: 't1', status: 'done' })
    await insertTask(store, { id: 't2', status: 'done' })
    await insertTask(store, { id: 't3', status: 'done' })
    await insertTask(store, { id: 't4', status: 'done' })
    await insertTask(store, { id: 't5', status: 'done' })
    await insertTask(store, { id: 't6', status: 'done' })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot!.failure_rate_low_confidence).toBe(0)
    expect(snapshot!.failure_rate_sample_count).toBe(6)
  })

  it('honours a custom sampleFloor applied uniformly to all four KPIs', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 't1', status: 'done' })
    await insertTask(store, { id: 't2', status: 'done' })

    // Custom floor of 3 → 2 samples < 3 → failure_rate_low_confidence=1
    const snapshot = await takeKpiSnapshot({
      surface: store,
      now: NOW,
      sampleFloor: 3,
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot!.failure_rate_low_confidence).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. NULL preservation for unfilled KPI columns
// ---------------------------------------------------------------------------

describe('takeKpiSnapshot — NULL preservation for unimplemented KPIs', () => {
  it('leaves cost_per_arc_p50 as null when done arc has no trace signals', async () => {
    const store = await makeStore()
    // A done task with no trace signal → frSampleCount=1 (writes row), costSampleCount=0 (null)
    await insertTask(store, { id: 'done-no-signal', status: 'done' })
    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })
    expect(snapshot).not.toBeNull()
    expect(snapshot!.cost_per_arc_p50).toBeNull()
  })

  it('leaves cost_per_arc_p90 as null when done arc has no trace signals', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'done-no-signal', status: 'done' })
    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })
    expect(snapshot).not.toBeNull()
    expect(snapshot!.cost_per_arc_p90).toBeNull()
  })

  it('sets autonomous_completion_rate to null when no done arcs are in the window', async () => {
    const store = await makeStore()
    // A failed arc only → frSampleCount=1 (writes row), acrSampleCount=0 (no done arcs → null)
    await insertTask(store, { id: 'fail-only', status: 'failed' })
    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })
    expect(snapshot).not.toBeNull()
    expect(snapshot!.autonomous_completion_rate).toBeNull()
  })

  it('leaves recovery_success_rate as null when no recovery tasks have fired', async () => {
    const store = await makeStore()
    // A plain done task (no fix_for_task_id) → frSampleCount=1, rsrSampleCount=0
    await insertTask(store, { id: 'plain-done', status: 'done' })
    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })
    expect(snapshot).not.toBeNull()
    expect(snapshot!.recovery_success_rate).toBeNull()
  })

  it('readLatestKpiSnapshot returns null KPI columns when no signals exist', async () => {
    const store = await makeStore()
    // A done task with no signals → cost_per_arc columns null; no recovery → rsr null
    await insertTask(store, { id: 'done-plain', status: 'done' })
    await takeKpiSnapshot({ surface: store, now: NOW })

    const snap = await readLatestKpiSnapshot(store)
    expect(snap).not.toBeNull()
    expect(snap!.cost_per_arc_p50).toBeNull()
    expect(snap!.cost_per_arc_p90).toBeNull()
    // autonomous_completion_rate is non-null (1.0) because the done arc is autonomous
    expect(snap!.recovery_success_rate).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5. Window bounds are correctly stored
// ---------------------------------------------------------------------------

describe('takeKpiSnapshot — window metadata', () => {
  it('stores window_start as 7 days before now by default', async () => {
    const store = await makeStore()
    // Need at least one task so the guard doesn't suppress the write.
    await insertTask(store, { id: 'wm-task', status: 'done' })
    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    const expectedStart = new Date(
      new Date(NOW).getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString()

    expect(snapshot).not.toBeNull()
    expect(snapshot!.window_start).toBe(expectedStart)
    expect(snapshot!.window_end).toBe(NOW)
  })

  it('honours a custom windowDays', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'wm-task2', status: 'done' })
    const snapshot = await takeKpiSnapshot({
      surface: store,
      now: NOW,
      windowDays: 14,
    })

    const expectedStart = new Date(
      new Date(NOW).getTime() - 14 * 24 * 60 * 60 * 1000,
    ).toISOString()

    expect(snapshot).not.toBeNull()
    expect(snapshot!.window_start).toBe(expectedStart)
  })
})

// ---------------------------------------------------------------------------
// 6. cost_per_arc_p50 and cost_per_arc_p90 are persisted and round-trip
// ---------------------------------------------------------------------------

describe('takeKpiSnapshot — cost_per_arc columns', () => {
  it('persists cost_per_arc_p50 and cost_per_arc_p90 from done Arcs with signals', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'arc-a', status: 'done' })
    await insertSignal(store, { taskId: 'arc-a', inputTokens: 1000 })
    await insertTask(store, { id: 'arc-b', status: 'done' })
    await insertSignal(store, { taskId: 'arc-b', inputTokens: 3000 })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot).not.toBeNull()
    expect(snapshot!.cost_per_arc_p50).not.toBeNull()
    expect(snapshot!.cost_per_arc_p90).not.toBeNull()
    // Sorted costs: [1000, 3000], n=2
    // p50 index = 0.5, lo=0, hi=1 → 1000 + 0.5*2000 = 2000
    // p90 index = 0.9, lo=0, hi=1 → 1000 + 0.9*2000 = 2800
    expect(snapshot!.cost_per_arc_p50).toBeCloseTo(2000, 5)
    expect(snapshot!.cost_per_arc_p90).toBeCloseTo(2800, 5)
  })

  it('sets both to null when no done Arcs are in the window', async () => {
    const store = await makeStore()
    // A failed arc — must not contribute to cost distribution; but frSampleCount=1 so row is written
    await insertTask(store, { id: 'fail-arc', status: 'failed' })
    await insertSignal(store, { taskId: 'fail-arc', inputTokens: 5000 })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot).not.toBeNull()
    expect(snapshot!.cost_per_arc_p50).toBeNull()
    expect(snapshot!.cost_per_arc_p90).toBeNull()
  })

  it('readLatestKpiSnapshot returns persisted cost_per_arc values', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'arc-x', status: 'done' })
    await insertSignal(store, { taskId: 'arc-x', inputTokens: 500 })

    const written = await takeKpiSnapshot({ surface: store, now: NOW })
    const read = await readLatestKpiSnapshot(store)

    expect(written).not.toBeNull()
    expect(read!.cost_per_arc_p50).toBeCloseTo(written!.cost_per_arc_p50!, 5)
    expect(read!.cost_per_arc_p90).toBeCloseTo(written!.cost_per_arc_p90!, 5)
  })
})

// ---------------------------------------------------------------------------
// 7. readKpiWindowComparison — current + prior + deltas
// ---------------------------------------------------------------------------

describe('readKpiWindowComparison', () => {
  // Window constants (each window is 7 days wide, contiguous)
  const CMP_NOW = '2026-01-14T12:00:00Z'
  const CMP_CURRENT_START = '2026-01-07T12:00:00Z' // CMP_NOW - 7 days
  const CMP_PRIOR_END = CMP_CURRENT_START
  const CMP_PRIOR_START = '2025-12-31T12:00:00Z' // CMP_PRIOR_END - 7 days

  it('(a) returns numeric deltas when both windows are full-confidence', async () => {
    const store = await makeStore()

    // Prior window snapshot — full confidence (all per-KPI flags=0), distinct KPI values
    await insertSnapshot(store, {
      id: randomUUID(),
      taken_at: CMP_PRIOR_END,
      window_start: CMP_PRIOR_START,
      window_end: CMP_PRIOR_END,
      failure_rate_sample_count: 10,
      failure_rate_low_confidence: 0,
      cost_per_arc_sample_count: 10,
      cost_per_arc_low_confidence: 0,
      autonomous_completion_rate_sample_count: 10,
      autonomous_completion_rate_low_confidence: 0,
      recovery_success_rate_sample_count: 10,
      recovery_success_rate_low_confidence: 0,
      failure_rate: 0.2,
      cost_per_arc_p50: 1000,
      cost_per_arc_p90: 3000,
    })

    // Current window snapshot — full confidence, different values
    await insertSnapshot(store, {
      id: randomUUID(),
      taken_at: CMP_NOW,
      window_start: CMP_CURRENT_START,
      window_end: CMP_NOW,
      failure_rate_sample_count: 10,
      failure_rate_low_confidence: 0,
      cost_per_arc_sample_count: 10,
      cost_per_arc_low_confidence: 0,
      autonomous_completion_rate_sample_count: 10,
      autonomous_completion_rate_low_confidence: 0,
      recovery_success_rate_sample_count: 10,
      recovery_success_rate_low_confidence: 0,
      failure_rate: 0.1,
      cost_per_arc_p50: 1200,
      cost_per_arc_p90: 3500,
    })

    const result = await readKpiWindowComparison({ now: CMP_NOW, store })

    expect(result.current).not.toBeNull()
    expect(result.prior).not.toBeNull()

    // failure_rate: 0.1 - 0.2 = -0.1
    expect(result.deltas.failure_rate.lowConfidenceSuppressed).toBe(false)
    expect(result.deltas.failure_rate.value).not.toBeNull()
    expect(result.deltas.failure_rate.value!).toBeCloseTo(-0.1, 5)

    // cost_per_arc_p50: 1200 - 1000 = 200
    expect(result.deltas.cost_per_arc_p50.lowConfidenceSuppressed).toBe(false)
    expect(result.deltas.cost_per_arc_p50.value).not.toBeNull()
    expect(result.deltas.cost_per_arc_p50.value!).toBeCloseTo(200, 5)

    // cost_per_arc_p90: 3500 - 3000 = 500
    expect(result.deltas.cost_per_arc_p90.lowConfidenceSuppressed).toBe(false)
    expect(result.deltas.cost_per_arc_p90.value!).toBeCloseTo(500, 5)

    // Unimplemented KPIs (null in both snapshots): value=null, not suppressed
    expect(result.deltas.autonomous_completion_rate).toEqual({
      value: null,
      lowConfidenceSuppressed: false,
    })
    expect(result.deltas.recovery_success_rate).toEqual({
      value: null,
      lowConfidenceSuppressed: false,
    })
  })

  it('(b) suppresses all deltas when prior window has all per-KPI low_confidence=1 (sample_count=3)', async () => {
    const store = await makeStore()

    // Prior window snapshot — all KPIs low confidence (3 samples < default floor 5)
    await insertSnapshot(store, {
      id: randomUUID(),
      taken_at: CMP_PRIOR_END,
      window_start: CMP_PRIOR_START,
      window_end: CMP_PRIOR_END,
      failure_rate_sample_count: 3,
      failure_rate_low_confidence: 1,
      cost_per_arc_sample_count: 3,
      cost_per_arc_low_confidence: 1,
      autonomous_completion_rate_sample_count: 3,
      autonomous_completion_rate_low_confidence: 1,
      recovery_success_rate_sample_count: 3,
      recovery_success_rate_low_confidence: 1,
      failure_rate: 0.33,
      cost_per_arc_p50: 800,
      cost_per_arc_p90: 2500,
    })

    // Current window snapshot — all KPIs full confidence
    await insertSnapshot(store, {
      id: randomUUID(),
      taken_at: CMP_NOW,
      window_start: CMP_CURRENT_START,
      window_end: CMP_NOW,
      failure_rate_sample_count: 10,
      failure_rate_low_confidence: 0,
      cost_per_arc_sample_count: 10,
      cost_per_arc_low_confidence: 0,
      autonomous_completion_rate_sample_count: 10,
      autonomous_completion_rate_low_confidence: 0,
      recovery_success_rate_sample_count: 10,
      recovery_success_rate_low_confidence: 0,
      failure_rate: 0.1,
      cost_per_arc_p50: 1000,
      cost_per_arc_p90: 3000,
    })

    const result = await readKpiWindowComparison({ now: CMP_NOW, store })

    expect(result.current).not.toBeNull()
    expect(result.prior).not.toBeNull()

    // All deltas suppressed because prior has low_confidence=1
    const kpiKeys = [
      'failure_rate',
      'cost_per_arc_p50',
      'cost_per_arc_p90',
      'autonomous_completion_rate',
      'recovery_success_rate',
    ] as const
    for (const key of kpiKeys) {
      expect(result.deltas[key]).toEqual({ value: null, lowConfidenceSuppressed: true })
    }
  })

  it('(c) returns prior=null and unsuppressed null deltas when no prior snapshot exists', async () => {
    const store = await makeStore()

    // Only a current snapshot — no prior in the DB
    await insertSnapshot(store, {
      id: randomUUID(),
      taken_at: CMP_NOW,
      window_start: CMP_CURRENT_START,
      window_end: CMP_NOW,
      failure_rate_sample_count: 10,
      failure_rate_low_confidence: 0,
      cost_per_arc_sample_count: 10,
      cost_per_arc_low_confidence: 0,
      autonomous_completion_rate_sample_count: 10,
      autonomous_completion_rate_low_confidence: 0,
      recovery_success_rate_sample_count: 10,
      recovery_success_rate_low_confidence: 0,
      failure_rate: 0.1,
    })

    const result = await readKpiWindowComparison({ now: CMP_NOW, store })

    expect(result.current).not.toBeNull()
    expect(result.prior).toBeNull()

    // All deltas: value=null, lowConfidenceSuppressed=false (no prior to compare)
    const kpiKeys = [
      'failure_rate',
      'cost_per_arc_p50',
      'cost_per_arc_p90',
      'autonomous_completion_rate',
      'recovery_success_rate',
    ] as const
    for (const key of kpiKeys) {
      expect(result.deltas[key]).toEqual({ value: null, lowConfidenceSuppressed: false })
    }
  })
})

// ---------------------------------------------------------------------------
// 8. autonomous_completion_rate is computed and persisted
// ---------------------------------------------------------------------------

describe('takeKpiSnapshot — autonomous_completion_rate column', () => {
  it('clean done-Arc IS counted as autonomous (value=1)', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'clean-arc', status: 'done' })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot).not.toBeNull()
    expect(snapshot!.autonomous_completion_rate).not.toBeNull()
    expect(snapshot!.autonomous_completion_rate).toBe(1)
  })

  it('Arc with a fix_for_task_id task in its tree is NOT counted as autonomous', async () => {
    const store = await makeStore()
    // Origin failed; recovery task reached done
    await insertTask(store, { id: 'origin', status: 'failed' })
    await insertTask(store, {
      id: 'fix',
      status: 'done',
      fix_for_task_id: 'origin',
    })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    // 1 done arc (origin), 0 autonomous → value = 0
    expect(snapshot).not.toBeNull()
    expect(snapshot!.autonomous_completion_rate).not.toBeNull()
    expect(snapshot!.autonomous_completion_rate).toBe(0)
  })

  it('Arc with a task-blocked action-queue item is NOT counted as autonomous', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'blocked-task', status: 'done' })
    await store.execute({
      sql: `INSERT INTO action_queue_items
              (id, kind, category, priority, title, raised_by, raised_at, origin_task_id)
            VALUES (?, 'task-blocked', 'orchestrator', 'high', 'blocked', 'test', ?, ?)`,
      // `raised_at` is a bigint of epoch millis, unlike the ISO-string `now`
      // that `takeKpiSnapshot` takes. Passing NOW verbatim is a cast error.
      args: ['aq-1', Date.parse(NOW), 'blocked-task'],
    })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    // 1 done arc with task-blocked item → 0 autonomous → value = 0
    expect(snapshot).not.toBeNull()
    expect(snapshot!.autonomous_completion_rate).not.toBeNull()
    expect(snapshot!.autonomous_completion_rate).toBe(0)
  })

  it('persists autonomous_completion_rate so readLatestKpiSnapshot returns it', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 't1', status: 'done' })
    await insertTask(store, { id: 't2', status: 'done' })

    await takeKpiSnapshot({ surface: store, now: NOW })
    const snap = await readLatestKpiSnapshot(store)

    expect(snap).not.toBeNull()
    expect(snap!.autonomous_completion_rate).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 9. readKpiSeries — last-N oldest-first time-series
// ---------------------------------------------------------------------------

describe('readKpiSeries', () => {
  it('returns empty arrays for all series when the store has no snapshots', async () => {
    const store = await makeStore()
    const series = await readKpiSeries({ store })
    expect(series.failure_rate).toEqual([])
    expect(series.autonomous_completion_rate).toEqual([])
    expect(series.recovery_success_rate).toEqual([])
    expect(series.cost_per_arc_p50).toEqual([])
  })

  it('returns the most-recent N snapshots ordered oldest-first when rows exceed limit', async () => {
    const store = await makeStore()
    const times = [
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
      '2026-01-03T00:00:00Z',
      '2026-01-04T00:00:00Z',
      '2026-01-05T00:00:00Z',
    ]
    for (const t of times) {
      await insertSnapshot(store, {
        id: randomUUID(),
        taken_at: t,
        window_start: t,
        window_end: t,
        failure_rate: 0.1,
      })
    }
    // limit=3 → last 3 (Jan 3, Jan 4, Jan 5) in ascending order
    const series = await readKpiSeries({ store, limit: 3 })
    expect(series.failure_rate).toHaveLength(3)
    expect(series.failure_rate[0].takenAt).toBe('2026-01-03T00:00:00Z')
    expect(series.failure_rate[1].takenAt).toBe('2026-01-04T00:00:00Z')
    expect(series.failure_rate[2].takenAt).toBe('2026-01-05T00:00:00Z')
  })

  it('preserves null column values as value: null in each series', async () => {
    const store = await makeStore()
    await insertSnapshot(store, {
      id: randomUUID(),
      taken_at: '2026-01-01T00:00:00Z',
      window_start: '2025-12-25T00:00:00Z',
      window_end: '2026-01-01T00:00:00Z',
      failure_rate: null,
      autonomous_completion_rate: null,
      recovery_success_rate: null,
      cost_per_arc_p50: null,
    })
    const series = await readKpiSeries({ store })
    expect(series.failure_rate[0].value).toBeNull()
    expect(series.autonomous_completion_rate[0].value).toBeNull()
    expect(series.recovery_success_rate[0].value).toBeNull()
    expect(series.cost_per_arc_p50[0].value).toBeNull()
  })

  it('returns points in ascending order by takenAt', async () => {
    const store = await makeStore()
    // Insert in non-chronological order to confirm sorting is applied
    const times = ['2026-01-03T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z']
    for (const t of times) {
      await insertSnapshot(store, {
        id: randomUUID(),
        taken_at: t,
        window_start: t,
        window_end: t,
        failure_rate: 0.1,
      })
    }
    const series = await readKpiSeries({ store })
    const takenAts = series.failure_rate.map((p) => p.takenAt)
    expect(takenAts).toEqual([...takenAts].sort())
  })
})

// ---------------------------------------------------------------------------
// 10. Per-KPI sample_count and low_confidence — independent confidence flags
// ---------------------------------------------------------------------------

describe('takeKpiSnapshot — per-KPI confidence flags are independent', () => {
  it('thin cost sample flags cost_per_arc_low_confidence=1 while failure_rate_low_confidence=0', async () => {
    const store = await makeStore()
    // 8 done/failed arcs → failure_rate population = 8 (≥ default sampleFloor 5)
    for (let i = 1; i <= 6; i++) {
      await insertTask(store, { id: `task-done-${i}`, status: 'done' })
    }
    await insertTask(store, { id: 'task-failed-1', status: 'failed' })
    await insertTask(store, { id: 'task-failed-2', status: 'failed' })

    // Only 2 done arcs have cost signals → cost_per_arc population = 2 (< 5)
    await insertSignal(store, { taskId: 'task-done-1', inputTokens: 1000 })
    await insertSignal(store, { taskId: 'task-done-2', inputTokens: 2000 })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot).not.toBeNull()
    // failure_rate population: 8 done+failed arcs → high confidence
    expect(snapshot!.failure_rate_sample_count).toBe(8)
    expect(snapshot!.failure_rate_low_confidence).toBe(0)

    // cost_per_arc population: 2 done arcs with signals → low confidence
    expect(snapshot!.cost_per_arc_sample_count).toBe(2)
    expect(snapshot!.cost_per_arc_low_confidence).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 11. buildDeltas per-KPI suppression — cost_per_arc and failure_rate are independent
// ---------------------------------------------------------------------------

describe('readKpiWindowComparison — per-KPI delta suppression', () => {
  const CMP_NOW = '2026-01-14T12:00:00Z'
  const CMP_CURRENT_START = '2026-01-07T12:00:00Z'
  const CMP_PRIOR_END = CMP_CURRENT_START
  const CMP_PRIOR_START = '2025-12-31T12:00:00Z'

  it('suppresses cost_per_arc deltas based on cost_per_arc confidence while leaving failure_rate unsuppressed', async () => {
    const store = await makeStore()

    // Prior snapshot: cost_per_arc_low_confidence=1, failure_rate_low_confidence=0
    await insertSnapshot(store, {
      id: randomUUID(),
      taken_at: CMP_PRIOR_END,
      window_start: CMP_PRIOR_START,
      window_end: CMP_PRIOR_END,
      failure_rate_sample_count: 10,
      failure_rate_low_confidence: 0,
      cost_per_arc_sample_count: 2,
      cost_per_arc_low_confidence: 1,
      failure_rate: 0.2,
      cost_per_arc_p50: 1000,
      cost_per_arc_p90: 3000,
    })

    // Current snapshot: all per-KPI flags = full confidence
    await insertSnapshot(store, {
      id: randomUUID(),
      taken_at: CMP_NOW,
      window_start: CMP_CURRENT_START,
      window_end: CMP_NOW,
      failure_rate_sample_count: 10,
      failure_rate_low_confidence: 0,
      cost_per_arc_sample_count: 10,
      cost_per_arc_low_confidence: 0,
      failure_rate: 0.1,
      cost_per_arc_p50: 1200,
      cost_per_arc_p90: 3500,
    })

    const result = await readKpiWindowComparison({ now: CMP_NOW, store })

    expect(result.current).not.toBeNull()
    expect(result.prior).not.toBeNull()

    // failure_rate: both snapshots have failure_rate_low_confidence=0 → delta computed
    expect(result.deltas.failure_rate.lowConfidenceSuppressed).toBe(false)
    expect(result.deltas.failure_rate.value).not.toBeNull()
    expect(result.deltas.failure_rate.value!).toBeCloseTo(-0.1, 5)

    // cost_per_arc: prior has cost_per_arc_low_confidence=1 → deltas suppressed
    expect(result.deltas.cost_per_arc_p50).toEqual({ value: null, lowConfidenceSuppressed: true })
    expect(result.deltas.cost_per_arc_p90).toEqual({ value: null, lowConfidenceSuppressed: true })
  })
})

// ---------------------------------------------------------------------------
// 12. Daemon periodic job: takeKpiSnapshot writes a row for a synthetic window
// ---------------------------------------------------------------------------
// These tests verify the behaviour invoked by the daemon's runKpiSnapshot()
// callback (setInterval sweep registered in server.ts). The daemon calls
// takeKpiSnapshot({ surface, now }) and logs success; these tests confirm the
// write actually lands so the /kpis route has fresh data.
// ---------------------------------------------------------------------------

describe('takeKpiSnapshot — daemon periodic-job contract', () => {
  it('writes exactly one kpi_snapshots row when the window contains tasks', async () => {
    const store = await makeStore()
    // Seed enough tasks to pass the sample-count guard
    await insertTask(store, { id: 'daemon-t1', status: 'done' })
    await insertTask(store, { id: 'daemon-t2', status: 'done' })
    await insertTask(store, { id: 'daemon-t3', status: 'failed' })

    // Simulate what the daemon's runKpiSnapshot() callback does
    const snap = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snap).not.toBeNull()

    const latest = await readLatestKpiSnapshot(store)
    expect(latest).not.toBeNull()
    expect(latest!.id).toBe(snap!.id)
    expect(latest!.taken_at).toBe(NOW)
    // failure_rate should be computed (1 failed / 3 total ≈ 0.333)
    expect(latest!.failure_rate).not.toBeNull()
    expect(latest!.failure_rate!).toBeCloseTo(1 / 3, 5)
  })

  it('does NOT write a row when the window contains no terminal tasks (all-zero guard)', async () => {
    const store = await makeStore()
    // No tasks at all → guard returns null
    const snap = await takeKpiSnapshot({ surface: store, now: NOW })
    expect(snap).toBeNull()

    const latest = await readLatestKpiSnapshot(store)
    expect(latest).toBeNull()
  })

  it('successive calls write successive rows; readLatestKpiSnapshot returns the newest', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'suc-t1', status: 'done' })

    const first = await takeKpiSnapshot({ surface: store, now: '2026-01-06T00:00:00Z' })
    const second = await takeKpiSnapshot({ surface: store, now: '2026-01-07T00:00:00Z' })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    const latest = await readLatestKpiSnapshot(store)
    expect(latest!.id).toBe(second!.id)
    expect(latest!.taken_at).toBe('2026-01-07T00:00:00Z')
  })
})
