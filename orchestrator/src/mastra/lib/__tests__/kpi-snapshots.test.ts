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

const makeStore = async (): Promise<TaskStore> => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-kpi-snapshots-'))
  const client = openLibsql({ url: `file:${join(dir, 'queue.db')}` })
  await client.execute(TASKS_DDL)
  await client.execute(KPI_SNAPSHOTS_DDL)
  return createLibsqlTaskStore(client)
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
