/**
 * Unit tests for getCostPerMergedTask.
 *
 * Uses the shared PGlite test database (via getTestDb) which carries the full
 * Mars schema including `tasks` and `trace_events`. Seed tasks + step_ended
 * trace events to exercise the query and TypeScript aggregation logic.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { getTestDb } from '../../../../test/db-fixture.js'
import type { DbClient } from '../db.js'
import {
  getCostPerMergedTask,
  PROVIDER_PRICING,
  TOKEN_WEIGHTS,
} from './cost-per-merged-task.js'

// ── Seed helpers ──────────────────────────────────────────────────────────────

const insertTask = async (
  db: DbClient,
  opts: {
    id: string
    status: string
    updatedAt: string
  },
): Promise<void> => {
  await db.execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
          VALUES ($1, '', $2, $3, $3)`,
    args: [opts.id, opts.status, opts.updatedAt],
  })
}

let stepSeq = 0
const insertStepEnded = async (
  db: DbClient,
  opts: {
    taskId: string
    workerName: string
    inputTokens: number
    outputTokens: number
    cacheCreateTokens?: number
    cacheReadTokens?: number
    ts?: number
  },
): Promise<void> => {
  const ts = opts.ts ?? (Date.now() + ++stepSeq)
  const payload = JSON.stringify({
    stepName: 'code',
    workerName: opts.workerName,
    outcome: 'completed',
    durationMs: 1000,
    usageSignals: {
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      cacheCreateTokens: opts.cacheCreateTokens ?? 0,
      cacheReadTokens: opts.cacheReadTokens ?? 0,
      messageCount: 1,
    },
  })
  await db.execute({
    sql: `INSERT INTO trace_events (id, timestamp, kind, severity, task_id, payload)
          VALUES ($1, $2, 'step_ended', 'info', $3, $4)`,
    args: [`te-${++stepSeq}`, ts, opts.taskId, payload],
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TOKEN_WEIGHTS', () => {
  it('exports expected weight constants', () => {
    expect(TOKEN_WEIGHTS.input).toBe(1)
    expect(TOKEN_WEIGHTS.output).toBe(1)
    expect(TOKEN_WEIGHTS.cacheRead).toBeCloseTo(0.1)
    expect(TOKEN_WEIGHTS.cacheCreate).toBeCloseTo(1.25)
  })
})

describe('PROVIDER_PRICING', () => {
  it('has entries for core worker names with inputPer1M and outputPer1M', () => {
    const workerNames = ['Coder', 'Fixer', 'Planner', 'Slicer', 'Triager']
    for (const name of workerNames) {
      expect(PROVIDER_PRICING[name], `pricing missing for ${name}`).toBeDefined()
      expect(typeof PROVIDER_PRICING[name]!.inputPer1M).toBe('number')
      expect(typeof PROVIDER_PRICING[name]!.outputPer1M).toBe('number')
    }
  })
})

describe('getCostPerMergedTask — empty DB', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await getTestDb()
    stepSeq = 0
  })

  it('returns zero counts and null cost when no tasks exist', async () => {
    const result = await getCostPerMergedTask(db, { windowDays: 30 })
    expect(result.current.mergedCount).toBe(0)
    expect(result.current.tokens).toBe(0)
    expect(result.current.costUsd).toBeNull()
    expect(result.current.avgCostPerMerge).toBeNull()
    expect(result.current.excludedNullCostCount).toBe(0)
    expect(result.trend).toHaveLength(0)
  })
})

describe('getCostPerMergedTask — done tasks with known pricing', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await getTestDb()
    stepSeq = 0
  })

  it('counts only done tasks — failed/dropped are excluded', async () => {
    const now = new Date().toISOString()
    await insertTask(db, { id: 'task-done', status: 'done', updatedAt: now })
    await insertTask(db, { id: 'task-failed', status: 'failed', updatedAt: now })
    await insertTask(db, { id: 'task-dropped', status: 'dropped', updatedAt: now })

    await insertStepEnded(db, { taskId: 'task-done', workerName: 'Coder', inputTokens: 1000, outputTokens: 500 })

    const result = await getCostPerMergedTask(db, { windowDays: 30 })
    expect(result.current.mergedCount).toBe(1)
  })

  it('computes weighted tokens correctly for a single task', async () => {
    const now = new Date().toISOString()
    await insertTask(db, { id: 'task-tokens', status: 'done', updatedAt: now })
    await insertStepEnded(db, {
      taskId: 'task-tokens',
      workerName: 'Coder',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreateTokens: 200,
      cacheReadTokens: 400,
    })

    const result = await getCostPerMergedTask(db, { windowDays: 30 })
    // weighted = 1000*1 + 500*1 + 200*1.25 + 400*0.1 = 1000+500+250+40 = 1790
    expect(result.current.tokens).toBeCloseTo(1790)
  })

  it('computes USD cost using PROVIDER_PRICING for known workerName', async () => {
    const now = new Date().toISOString()
    await insertTask(db, { id: 'task-cost', status: 'done', updatedAt: now })
    // Coder: inputPer1M=3.0, outputPer1M=15.0
    await insertStepEnded(db, {
      taskId: 'task-cost',
      workerName: 'Coder',
      inputTokens: 1_000_000, // $3.00
      outputTokens: 100_000,  // $1.50
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })

    const result = await getCostPerMergedTask(db, { windowDays: 30 })
    // costUsd = 1_000_000 * 3.0/1_000_000 + 100_000 * 15.0/1_000_000 = 3.0 + 1.5 = 4.5
    expect(result.current.costUsd).toBeCloseTo(4.5)
    expect(result.current.avgCostPerMerge).toBeCloseTo(4.5)
    expect(result.current.excludedNullCostCount).toBe(0)
  })

  it('excludes tasks with unknown workerName from avgCostPerMerge', async () => {
    const now = new Date().toISOString()
    await insertTask(db, { id: 'task-known', status: 'done', updatedAt: now })
    await insertTask(db, { id: 'task-unknown-worker', status: 'done', updatedAt: now })

    await insertStepEnded(db, { taskId: 'task-known', workerName: 'Coder', inputTokens: 1_000_000, outputTokens: 0 })
    await insertStepEnded(db, { taskId: 'task-unknown-worker', workerName: 'UnknownWorker', inputTokens: 2_000_000, outputTokens: 0 })

    const result = await getCostPerMergedTask(db, { windowDays: 30 })
    expect(result.current.mergedCount).toBe(2)
    expect(result.current.excludedNullCostCount).toBe(1)
    // Only task-known contributes: $3.00 / 1 task
    expect(result.current.avgCostPerMerge).toBeCloseTo(3.0)
    expect(result.current.costUsd).toBeCloseTo(3.0)
  })

  it('sums multiple steps within one task', async () => {
    const now = new Date().toISOString()
    await insertTask(db, { id: 'task-multi-step', status: 'done', updatedAt: now })

    // Step 1: Coder — 1M input ($3.00)
    await insertStepEnded(db, { taskId: 'task-multi-step', workerName: 'Coder', inputTokens: 1_000_000, outputTokens: 0 })
    // Step 2: Coder — 500k input ($1.50)
    await insertStepEnded(db, { taskId: 'task-multi-step', workerName: 'Coder', inputTokens: 500_000, outputTokens: 0 })

    const result = await getCostPerMergedTask(db, { windowDays: 30 })
    expect(result.current.mergedCount).toBe(1)
    // total cost = $3.00 + $1.50 = $4.50; one task -> avg = $4.50
    expect(result.current.costUsd).toBeCloseTo(4.5)
    expect(result.current.avgCostPerMerge).toBeCloseTo(4.5)
  })

  it('includes tasks with no step_ended events in mergedCount but not in costUsd', async () => {
    const now = new Date().toISOString()
    await insertTask(db, { id: 'task-no-steps', status: 'done', updatedAt: now })
    await insertTask(db, { id: 'task-has-steps', status: 'done', updatedAt: now })

    await insertStepEnded(db, { taskId: 'task-has-steps', workerName: 'Coder', inputTokens: 1_000_000, outputTokens: 0 })

    const result = await getCostPerMergedTask(db, { windowDays: 30 })
    expect(result.current.mergedCount).toBe(2)
    // task-no-steps has null cost → excluded
    expect(result.current.excludedNullCostCount).toBe(1)
    // avg only over task-has-steps: $3.00
    expect(result.current.avgCostPerMerge).toBeCloseTo(3.0)
  })

  it('excludes tasks whose updated_at is outside the window', async () => {
    const farPast = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() // 60 days ago
    const recent = new Date().toISOString()
    await insertTask(db, { id: 'task-old', status: 'done', updatedAt: farPast })
    await insertTask(db, { id: 'task-recent', status: 'done', updatedAt: recent })

    await insertStepEnded(db, { taskId: 'task-old', workerName: 'Coder', inputTokens: 1_000_000, outputTokens: 0 })
    await insertStepEnded(db, { taskId: 'task-recent', workerName: 'Coder', inputTokens: 500_000, outputTokens: 0 })

    const result = await getCostPerMergedTask(db, { windowDays: 30 })
    // Only task-recent is in the 30-day window
    expect(result.current.mergedCount).toBe(1)
    expect(result.current.costUsd).toBeCloseTo(1.5) // 500k * 3.0/1M
  })
})

describe('getCostPerMergedTask — trend', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await getTestDb()
    stepSeq = 0
  })

  it('groups merged tasks by day oldest-first', async () => {
    const day1 = '2026-01-10T12:00:00.000Z'
    const day2 = '2026-01-12T12:00:00.000Z'

    await insertTask(db, { id: 'task-d1a', status: 'done', updatedAt: day1 })
    await insertTask(db, { id: 'task-d1b', status: 'done', updatedAt: day1 })
    await insertTask(db, { id: 'task-d2', status: 'done', updatedAt: day2 })

    await insertStepEnded(db, { taskId: 'task-d1a', workerName: 'Coder', inputTokens: 1_000_000, outputTokens: 0 })
    await insertStepEnded(db, { taskId: 'task-d1b', workerName: 'Coder', inputTokens: 1_000_000, outputTokens: 0 })
    await insertStepEnded(db, { taskId: 'task-d2', workerName: 'Coder', inputTokens: 2_000_000, outputTokens: 0 })

    const windowDays = Math.ceil(
      (Date.now() - new Date(day1).getTime()) / (24 * 60 * 60 * 1000),
    ) + 1

    const result = await getCostPerMergedTask(db, { windowDays })

    expect(result.trend).toHaveLength(2)
    expect(result.trend[0]!.day).toBe('2026-01-10')
    expect(result.trend[0]!.mergedCount).toBe(2)
    // avg = (3.00 + 3.00) / 2 = 3.00
    expect(result.trend[0]!.avgCostPerMerge).toBeCloseTo(3.0)

    expect(result.trend[1]!.day).toBe('2026-01-12')
    expect(result.trend[1]!.mergedCount).toBe(1)
    // avg = 2M * 3.0/1M = $6.00
    expect(result.trend[1]!.avgCostPerMerge).toBeCloseTo(6.0)
  })

  it('returns null avgCostPerMerge for a day where all tasks have unknown pricing', async () => {
    const day = '2026-01-15T12:00:00.000Z'
    await insertTask(db, { id: 'task-unk', status: 'done', updatedAt: day })
    await insertStepEnded(db, { taskId: 'task-unk', workerName: 'GhostWorker', inputTokens: 1000, outputTokens: 500 })

    const windowDays = Math.ceil(
      (Date.now() - new Date(day).getTime()) / (24 * 60 * 60 * 1000),
    ) + 1

    const result = await getCostPerMergedTask(db, { windowDays })
    expect(result.trend).toHaveLength(1)
    expect(result.trend[0]!.avgCostPerMerge).toBeNull()
    expect(result.trend[0]!.mergedCount).toBe(1)
  })
})
