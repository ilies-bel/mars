import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openLibsql } from '../libsql.js'
import { createLibsqlTaskStore, type TaskStore } from '../task-store.js'
import { takeKpiSnapshot, readLatestKpiSnapshot } from '../kpi-snapshots.js'

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

const TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    origin_id TEXT,
    updated_at TEXT NOT NULL
  )
`

const KPI_SNAPSHOTS_DDL = `
  CREATE TABLE IF NOT EXISTS kpi_snapshots (
    id TEXT PRIMARY KEY,
    taken_at TEXT NOT NULL,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    sample_count INTEGER NOT NULL,
    low_confidence INTEGER NOT NULL,
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
    timestamp TEXT NOT NULL,
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
  await client.execute(KPI_SNAPSHOTS_DDL)
  await client.execute(TRACE_EVENTS_DDL)
  return createLibsqlTaskStore(client)
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
    args: [randomUUID(), '2026-01-04T12:00:01Z', opts.taskId, payload],
  })
}

const insertTask = async (
  store: TaskStore,
  opts: { id: string; status: string; updated_at?: string },
): Promise<void> => {
  await store.execute({
    sql: 'INSERT INTO tasks (id, status, origin_id, updated_at) VALUES (?, ?, NULL, ?)',
    args: [opts.id, opts.status, opts.updated_at ?? '2026-01-04T12:00:00Z'],
  })
}

const NOW = '2026-01-07T12:00:00Z'

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

    expect(read).not.toBeNull()
    expect(read!.id).toBe(written.id)
    expect(read!.taken_at).toBe(NOW)
  })

  it('readLatestKpiSnapshot returns null when no snapshot has been taken', async () => {
    const store = await makeStore()
    const result = await readLatestKpiSnapshot(store)
    expect(result).toBeNull()
  })

  it('readLatestKpiSnapshot returns the most recently taken snapshot', async () => {
    const store = await makeStore()
    const first = await takeKpiSnapshot({
      surface: store,
      now: '2026-01-06T00:00:00Z',
    })
    const second = await takeKpiSnapshot({
      surface: store,
      now: '2026-01-07T00:00:00Z',
    })

    const latest = await readLatestKpiSnapshot(store)
    expect(latest!.id).toBe(second.id)
    expect(latest!.id).not.toBe(first.id)
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
    expect(snapshot.failure_rate).not.toBeNull()
    expect(snapshot.failure_rate!).toBeCloseTo(1 / 3, 5)
    expect(snapshot.sample_count).toBe(3)
  })

  it('sets failure_rate to null when no arcs are in the window', async () => {
    const store = await makeStore()
    // No tasks inserted

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot.failure_rate).toBeNull()
    expect(snapshot.sample_count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. low_confidence flag at the sample floor boundary
// ---------------------------------------------------------------------------

describe('takeKpiSnapshot — low_confidence flag', () => {
  it('sets low_confidence=1 when sample_count < sampleFloor (default 5)', async () => {
    const store = await makeStore()
    // 4 tasks — just below the default floor of 5
    await insertTask(store, { id: 't1', status: 'done' })
    await insertTask(store, { id: 't2', status: 'done' })
    await insertTask(store, { id: 't3', status: 'done' })
    await insertTask(store, { id: 't4', status: 'done' })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot.low_confidence).toBe(1)
    expect(snapshot.sample_count).toBe(4)
  })

  it('sets low_confidence=0 when sample_count equals sampleFloor', async () => {
    const store = await makeStore()
    // Exactly 5 tasks — exactly at the default floor
    await insertTask(store, { id: 't1', status: 'done' })
    await insertTask(store, { id: 't2', status: 'done' })
    await insertTask(store, { id: 't3', status: 'done' })
    await insertTask(store, { id: 't4', status: 'done' })
    await insertTask(store, { id: 't5', status: 'done' })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot.low_confidence).toBe(0)
    expect(snapshot.sample_count).toBe(5)
  })

  it('sets low_confidence=0 when sample_count > sampleFloor', async () => {
    const store = await makeStore()
    // 6 tasks — above the default floor
    await insertTask(store, { id: 't1', status: 'done' })
    await insertTask(store, { id: 't2', status: 'done' })
    await insertTask(store, { id: 't3', status: 'done' })
    await insertTask(store, { id: 't4', status: 'done' })
    await insertTask(store, { id: 't5', status: 'done' })
    await insertTask(store, { id: 't6', status: 'done' })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot.low_confidence).toBe(0)
    expect(snapshot.sample_count).toBe(6)
  })

  it('honours a custom sampleFloor', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 't1', status: 'done' })
    await insertTask(store, { id: 't2', status: 'done' })

    // Custom floor of 3 → 2 samples < 3 → low_confidence=1
    const snapshot = await takeKpiSnapshot({
      surface: store,
      now: NOW,
      sampleFloor: 3,
    })

    expect(snapshot.low_confidence).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. NULL preservation for unfilled KPI columns
// ---------------------------------------------------------------------------

describe('takeKpiSnapshot — NULL preservation for unimplemented KPIs', () => {
  it('leaves cost_per_arc_p50 as null', async () => {
    const store = await makeStore()
    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })
    expect(snapshot.cost_per_arc_p50).toBeNull()
  })

  it('leaves cost_per_arc_p90 as null', async () => {
    const store = await makeStore()
    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })
    expect(snapshot.cost_per_arc_p90).toBeNull()
  })

  it('leaves autonomous_completion_rate as null', async () => {
    const store = await makeStore()
    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })
    expect(snapshot.autonomous_completion_rate).toBeNull()
  })

  it('leaves recovery_success_rate as null', async () => {
    const store = await makeStore()
    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })
    expect(snapshot.recovery_success_rate).toBeNull()
  })

  it('readLatestKpiSnapshot returns all null columns intact', async () => {
    const store = await makeStore()
    await takeKpiSnapshot({ surface: store, now: NOW })

    const snap = await readLatestKpiSnapshot(store)
    expect(snap).not.toBeNull()
    expect(snap!.cost_per_arc_p50).toBeNull()
    expect(snap!.cost_per_arc_p90).toBeNull()
    expect(snap!.autonomous_completion_rate).toBeNull()
    expect(snap!.recovery_success_rate).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5. Window bounds are correctly stored
// ---------------------------------------------------------------------------

describe('takeKpiSnapshot — window metadata', () => {
  it('stores window_start as 7 days before now by default', async () => {
    const store = await makeStore()
    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    const expectedStart = new Date(
      new Date(NOW).getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString()

    expect(snapshot.window_start).toBe(expectedStart)
    expect(snapshot.window_end).toBe(NOW)
  })

  it('honours a custom windowDays', async () => {
    const store = await makeStore()
    const snapshot = await takeKpiSnapshot({
      surface: store,
      now: NOW,
      windowDays: 14,
    })

    const expectedStart = new Date(
      new Date(NOW).getTime() - 14 * 24 * 60 * 60 * 1000,
    ).toISOString()

    expect(snapshot.window_start).toBe(expectedStart)
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

    expect(snapshot.cost_per_arc_p50).not.toBeNull()
    expect(snapshot.cost_per_arc_p90).not.toBeNull()
    // Sorted costs: [1000, 3000], n=2
    // p50 index = 0.5, lo=0, hi=1 → 1000 + 0.5*2000 = 2000
    // p90 index = 0.9, lo=0, hi=1 → 1000 + 0.9*2000 = 2800
    expect(snapshot.cost_per_arc_p50).toBeCloseTo(2000, 5)
    expect(snapshot.cost_per_arc_p90).toBeCloseTo(2800, 5)
  })

  it('sets both to null when no done Arcs are in the window', async () => {
    const store = await makeStore()
    // A failed arc — must not contribute to cost distribution
    await insertTask(store, { id: 'fail-arc', status: 'failed' })
    await insertSignal(store, { taskId: 'fail-arc', inputTokens: 5000 })

    const snapshot = await takeKpiSnapshot({ surface: store, now: NOW })

    expect(snapshot.cost_per_arc_p50).toBeNull()
    expect(snapshot.cost_per_arc_p90).toBeNull()
  })

  it('readLatestKpiSnapshot returns persisted cost_per_arc values', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'arc-x', status: 'done' })
    await insertSignal(store, { taskId: 'arc-x', inputTokens: 500 })

    const written = await takeKpiSnapshot({ surface: store, now: NOW })
    const read = await readLatestKpiSnapshot(store)

    expect(read!.cost_per_arc_p50).toBeCloseTo(written.cost_per_arc_p50!, 5)
    expect(read!.cost_per_arc_p90).toBeCloseTo(written.cost_per_arc_p90!, 5)
  })
})
