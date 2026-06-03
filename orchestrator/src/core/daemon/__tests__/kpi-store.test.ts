/**
 * Tests for listKpis — verifies that the daemon KPI endpoint reads real data
 * from the kpi_snapshots table rather than returning hardcoded zeros.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openLibsql } from '../../lib/libsql.js'
import { createLibsqlTaskStore, type TaskStore } from '../../lib/task-store.js'
import { listKpis } from '../kpi-store.js'

// ---------------------------------------------------------------------------
// Test DB helpers
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
  return createLibsqlTaskStore(client)
}

const insertSnapshot = async (
  store: TaskStore,
  s: {
    id: string
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
  },
): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO kpi_snapshots (
            id, taken_at, window_start, window_end,
            sample_count, low_confidence,
            cost_per_arc_p50, cost_per_arc_p90,
            failure_rate, autonomous_completion_rate, recovery_success_rate
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      s.id,
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

describe('listKpis — no snapshot', () => {
  it('returns four low-confidence zero-value records when table is empty', async () => {
    const store = await makeStore()
    const records = await listKpis(store)

    expect(records).toHaveLength(4)
    for (const r of records) {
      expect(r.sampleCount).toBe(0)
      expect(r.lowConfidence).toBe(true)
      expect(r.currentValue).toBe(0)
      expect(r.priorValue).toBe(0)
      expect(r.delta).toBe(0)
    }

    const keys = records.map((r) => r.key)
    expect(keys).toContain('cost_per_arc')
    expect(keys).toContain('failure_rate')
    expect(keys).toContain('autonomous_completion_rate')
    expect(keys).toContain('recovery_success_rate')
  })
})

describe('listKpis — with a high-confidence snapshot', () => {
  it('returns real values from the snapshot and lowConfidence=false', async () => {
    const store = await makeStore()
    // Insert a snapshot with window_end in the past so it is always found
    await insertSnapshot(store, {
      id: 'snap-1',
      taken_at: '2024-01-10T12:00:00Z',
      window_start: '2024-01-03T12:00:00Z',
      window_end: '2024-01-10T12:00:00Z',
      sample_count: 10,
      low_confidence: 0,
      failure_rate: 0.2,
      autonomous_completion_rate: 0.8,
      recovery_success_rate: 0.9,
      cost_per_arc_p50: 0.05,
      cost_per_arc_p90: 0.12,
    })

    const records = await listKpis(store)
    expect(records).toHaveLength(4)

    const byKey = Object.fromEntries(records.map((r) => [r.key, r]))

    expect(byKey.failure_rate.currentValue).toBeCloseTo(0.2)
    expect(byKey.failure_rate.sampleCount).toBe(10)
    expect(byKey.failure_rate.lowConfidence).toBe(false)
    expect(byKey.failure_rate.delta).toBe(0) // no prior snapshot → delta 0

    expect(byKey.autonomous_completion_rate.currentValue).toBeCloseTo(0.8)
    expect(byKey.autonomous_completion_rate.lowConfidence).toBe(false)

    expect(byKey.recovery_success_rate.currentValue).toBeCloseTo(0.9)
    expect(byKey.recovery_success_rate.lowConfidence).toBe(false)

    expect(byKey.cost_per_arc.currentValue).toBeCloseTo(0.05)
    expect(byKey.cost_per_arc.lowConfidence).toBe(false)
  })
})

describe('listKpis — snapshot with low confidence flag', () => {
  it('returns lowConfidence=true when snapshot.low_confidence=1', async () => {
    const store = await makeStore()
    await insertSnapshot(store, {
      id: 'snap-lc',
      taken_at: '2024-01-10T12:00:00Z',
      window_start: '2024-01-03T12:00:00Z',
      window_end: '2024-01-10T12:00:00Z',
      sample_count: 2,
      low_confidence: 1,
      failure_rate: 0.5,
      autonomous_completion_rate: 0.5,
      cost_per_arc_p50: 0.03,
    })

    const records = await listKpis(store)
    for (const r of records) {
      expect(r.lowConfidence).toBe(true)
    }

    // Values are still reported (not zeroed out)
    const byKey = Object.fromEntries(records.map((r) => [r.key, r]))
    expect(byKey.failure_rate.currentValue).toBeCloseTo(0.5)
    expect(byKey.failure_rate.sampleCount).toBe(2)
  })
})

describe('listKpis — delta computation with prior snapshot', () => {
  it('returns delta when both current and prior are high-confidence', async () => {
    const store = await makeStore()

    // prior snapshot: window 2023-12-27 to 2024-01-03
    await insertSnapshot(store, {
      id: 'snap-prior',
      taken_at: '2024-01-03T12:00:00Z',
      window_start: '2023-12-27T12:00:00Z',
      window_end: '2024-01-03T12:00:00Z',
      sample_count: 8,
      low_confidence: 0,
      failure_rate: 0.1,
      autonomous_completion_rate: 0.7,
      cost_per_arc_p50: 0.04,
    })

    // current snapshot: window 2024-01-03 to 2024-01-10
    await insertSnapshot(store, {
      id: 'snap-current',
      taken_at: '2024-01-10T12:00:00Z',
      window_start: '2024-01-03T12:00:00Z',
      window_end: '2024-01-10T12:00:00Z',
      sample_count: 10,
      low_confidence: 0,
      failure_rate: 0.2,
      autonomous_completion_rate: 0.8,
      cost_per_arc_p50: 0.05,
    })

    const records = await listKpis(store)
    const byKey = Object.fromEntries(records.map((r) => [r.key, r]))

    // delta = current - prior
    expect(byKey.failure_rate.delta).toBeCloseTo(0.1)   // 0.2 - 0.1
    expect(byKey.failure_rate.priorValue).toBeCloseTo(0.1)

    expect(byKey.autonomous_completion_rate.delta).toBeCloseTo(0.1) // 0.8 - 0.7

    expect(byKey.cost_per_arc.delta).toBeCloseTo(0.01) // 0.05 - 0.04
    expect(byKey.cost_per_arc.priorValue).toBeCloseTo(0.04)
  })
})
