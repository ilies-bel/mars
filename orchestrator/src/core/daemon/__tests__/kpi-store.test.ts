import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openLibsql } from '../../lib/libsql.js'
import { createTaskStore, type DomainTaskStore as TaskStore } from '../../store/task-store.js'
import { listKpis } from '../kpi-store.js'

// ---------------------------------------------------------------------------
// Test DB helpers (mirrors pattern in kpi-snapshots.test.ts)
// ---------------------------------------------------------------------------

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
  const dir = mkdtempSync(join(tmpdir(), 'mars-kpi-store-'))
  const client = openLibsql({ url: `file:${join(dir, 'queue.db')}` })
  await client.execute(KPI_SNAPSHOTS_DDL)
  return createTaskStore(client)
}

interface SnapshotRow {
  id?: string
  taken_at: string
  window_start: string
  window_end: string
  sample_count: number
  low_confidence: number
  failure_rate?: number | null
  cost_per_arc_p50?: number | null
  cost_per_arc_p90?: number | null
  autonomous_completion_rate?: number | null
  recovery_success_rate?: number | null
}

const insertSnapshot = async (store: TaskStore, s: SnapshotRow): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO kpi_snapshots (
            id, taken_at, window_start, window_end,
            sample_count, low_confidence,
            cost_per_arc_p50, cost_per_arc_p90,
            failure_rate, autonomous_completion_rate, recovery_success_rate
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      s.id ?? randomUUID(),
      s.taken_at,
      s.window_start,
      s.window_end,
      s.sample_count,
      s.low_confidence,
      s.cost_per_arc_p50 ?? null,
      s.cost_per_arc_p90 ?? null,
      s.failure_rate ?? null,
      s.autonomous_completion_rate ?? null,
      s.recovery_success_rate ?? null,
    ],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listKpis — empty table', () => {
  it('returns the all-zero low-confidence vector when no snapshot exists', async () => {
    const store = await makeStore()
    const kpis = await listKpis(store)

    expect(kpis).toHaveLength(4)
    for (const record of kpis) {
      expect(record.currentValue).toBe(0)
      expect(record.priorValue).toBe(0)
      expect(record.delta).toBe(0)
      expect(record.sampleCount).toBe(0)
      expect(record.lowConfidence).toBe(true)
    }
  })

  it('returns all four KPI keys in the correct order', async () => {
    const store = await makeStore()
    const kpis = await listKpis(store)
    expect(kpis.map((k) => k.key)).toEqual([
      'cost_per_arc',
      'failure_rate',
      'autonomous_completion_rate',
      'recovery_success_rate',
    ])
  })
})

describe('listKpis — populated table, high-confidence snapshot', () => {
  it('maps snapshot columns to KpiRecord non-zero values with lowConfidence:false', async () => {
    const store = await makeStore()

    // A single high-confidence snapshot (window_end in the past so it's picked up by
    // readKpiWindowComparison whose `now` is the current time)
    await insertSnapshot(store, {
      taken_at: '2025-01-07T12:00:00Z',
      window_start: '2024-12-31T12:00:00Z',
      window_end: '2025-01-07T12:00:00Z',
      sample_count: 10,
      low_confidence: 0,
      cost_per_arc_p50: 1234.5,
      cost_per_arc_p90: 5678.9,
      failure_rate: 0.2,
      autonomous_completion_rate: 0.8,
      recovery_success_rate: 0.9,
    })

    const kpis = await listKpis(store)
    expect(kpis).toHaveLength(4)

    const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]))

    // cost_per_arc maps to cost_per_arc_p50
    expect(byKey['cost_per_arc'].currentValue).toBeCloseTo(1234.5)
    expect(byKey['cost_per_arc'].lowConfidence).toBe(false)
    expect(byKey['cost_per_arc'].sampleCount).toBe(10)

    expect(byKey['failure_rate'].currentValue).toBeCloseTo(0.2)
    expect(byKey['failure_rate'].lowConfidence).toBe(false)

    expect(byKey['autonomous_completion_rate'].currentValue).toBeCloseTo(0.8)
    expect(byKey['autonomous_completion_rate'].lowConfidence).toBe(false)

    expect(byKey['recovery_success_rate'].currentValue).toBeCloseTo(0.9)
    expect(byKey['recovery_success_rate'].lowConfidence).toBe(false)
  })

  it('emits delta:0 and priorValue:=currentValue when there is no prior snapshot', async () => {
    const store = await makeStore()

    await insertSnapshot(store, {
      taken_at: '2025-01-07T12:00:00Z',
      window_start: '2024-12-31T12:00:00Z',
      window_end: '2025-01-07T12:00:00Z',
      sample_count: 10,
      low_confidence: 0,
      failure_rate: 0.3,
      cost_per_arc_p50: 500,
      autonomous_completion_rate: 0.7,
      recovery_success_rate: 0.6,
    })

    const kpis = await listKpis(store)
    for (const record of kpis) {
      expect(record.delta).toBe(0)
      expect(record.priorValue).toBe(record.currentValue)
    }
  })

  it('computes delta between two high-confidence snapshots', async () => {
    const store = await makeStore()

    // Prior window: Dec 24 – Dec 31
    await insertSnapshot(store, {
      taken_at: '2024-12-31T12:00:00Z',
      window_start: '2024-12-24T12:00:00Z',
      window_end: '2024-12-31T12:00:00Z',
      sample_count: 8,
      low_confidence: 0,
      failure_rate: 0.4,
      cost_per_arc_p50: 1000,
      autonomous_completion_rate: 0.6,
      recovery_success_rate: 0.5,
    })

    // Current window: Dec 31 – Jan 7
    await insertSnapshot(store, {
      taken_at: '2025-01-07T12:00:00Z',
      window_start: '2024-12-31T12:00:00Z',
      window_end: '2025-01-07T12:00:00Z',
      sample_count: 10,
      low_confidence: 0,
      failure_rate: 0.2,
      cost_per_arc_p50: 800,
      autonomous_completion_rate: 0.75,
      recovery_success_rate: 0.9,
    })

    const kpis = await listKpis(store)
    const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]))

    expect(byKey['failure_rate'].currentValue).toBeCloseTo(0.2)
    expect(byKey['failure_rate'].priorValue).toBeCloseTo(0.4)
    expect(byKey['failure_rate'].delta).toBeCloseTo(0.2 - 0.4)

    expect(byKey['cost_per_arc'].currentValue).toBeCloseTo(800)
    expect(byKey['cost_per_arc'].priorValue).toBeCloseTo(1000)
    expect(byKey['cost_per_arc'].delta).toBeCloseTo(800 - 1000)

    expect(byKey['autonomous_completion_rate'].delta).toBeCloseTo(0.75 - 0.6)
    expect(byKey['recovery_success_rate'].delta).toBeCloseTo(0.9 - 0.5)
  })
})

describe('listKpis — low-confidence and NULL column handling', () => {
  it('returns lowConfidence:true and zero values when snapshot has low_confidence=1', async () => {
    const store = await makeStore()

    await insertSnapshot(store, {
      taken_at: '2025-01-07T12:00:00Z',
      window_start: '2024-12-31T12:00:00Z',
      window_end: '2025-01-07T12:00:00Z',
      sample_count: 2,
      low_confidence: 1,
      failure_rate: 0.5,
      cost_per_arc_p50: 200,
      autonomous_completion_rate: 0.5,
      recovery_success_rate: 0.5,
    })

    const kpis = await listKpis(store)
    for (const record of kpis) {
      expect(record.lowConfidence).toBe(true)
    }
  })

  it('returns lowConfidence:true and zero values when a KPI column is NULL', async () => {
    const store = await makeStore()

    // Insert a snapshot where some columns are null (not yet computable)
    await insertSnapshot(store, {
      taken_at: '2025-01-07T12:00:00Z',
      window_start: '2024-12-31T12:00:00Z',
      window_end: '2025-01-07T12:00:00Z',
      sample_count: 10,
      low_confidence: 0,
      failure_rate: null,
      cost_per_arc_p50: null,
      autonomous_completion_rate: null,
      recovery_success_rate: null,
    })

    const kpis = await listKpis(store)
    for (const record of kpis) {
      expect(record.currentValue).toBe(0)
      expect(record.priorValue).toBe(0)
      expect(record.delta).toBe(0)
      expect(record.lowConfidence).toBe(true)
    }
  })

  it('suppresses delta when prior snapshot is low-confidence', async () => {
    const store = await makeStore()

    // Prior: low-confidence
    await insertSnapshot(store, {
      taken_at: '2024-12-31T12:00:00Z',
      window_start: '2024-12-24T12:00:00Z',
      window_end: '2024-12-31T12:00:00Z',
      sample_count: 2,
      low_confidence: 1,
      failure_rate: 0.4,
      cost_per_arc_p50: 1000,
      autonomous_completion_rate: 0.6,
      recovery_success_rate: 0.5,
    })

    // Current: high-confidence
    await insertSnapshot(store, {
      taken_at: '2025-01-07T12:00:00Z',
      window_start: '2024-12-31T12:00:00Z',
      window_end: '2025-01-07T12:00:00Z',
      sample_count: 10,
      low_confidence: 0,
      failure_rate: 0.2,
      cost_per_arc_p50: 800,
      autonomous_completion_rate: 0.75,
      recovery_success_rate: 0.9,
    })

    const kpis = await listKpis(store)
    for (const record of kpis) {
      expect(record.delta).toBe(0)
      expect(record.priorValue).toBe(record.currentValue)
    }
  })
})
