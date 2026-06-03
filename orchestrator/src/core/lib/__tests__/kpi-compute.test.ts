import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openLibsql } from '../libsql.js'
import { createTaskStore, type DomainTaskStore as TaskStore } from '../../store/task-store.js'
import {
  cacheWeightedTokens,
  computeAutonomousCompletionRate,
  computeCostPerArcDistribution,
  computeFailureRate,
  computeRecoverySuccessRate,
} from '../kpi-compute.js'

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

const ACTION_QUEUE_ITEMS_DDL = `
  CREATE TABLE IF NOT EXISTS action_queue_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    origin_task_id TEXT
  )
`

const makeStore = async (): Promise<TaskStore> => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-kpi-compute-'))
  const client = openLibsql({ url: `file:${join(dir, 'queue.db')}` })
  await client.execute(TASKS_DDL)
  await client.execute(TRACE_EVENTS_DDL)
  await client.execute(ACTION_QUEUE_ITEMS_DDL)
  return createTaskStore(client)
}

const insertTask = async (
  store: TaskStore,
  opts: {
    id: string
    status: string
    origin_id?: string | null
    fix_for_task_id?: string | null
    updated_at?: string
  },
): Promise<void> => {
  await store.execute({
    sql: 'INSERT INTO tasks (id, status, origin_id, fix_for_task_id, updated_at) VALUES (?, ?, ?, ?, ?)',
    args: [
      opts.id,
      opts.status,
      opts.origin_id ?? null,
      opts.fix_for_task_id ?? null,
      opts.updated_at ?? '2026-01-04T12:00:00Z',
    ],
  })
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

// Window that covers our test tasks
const WINDOW = {
  windowStart: '2026-01-01T00:00:00Z',
  windowEnd: '2026-01-07T23:59:59Z',
}

// ---------------------------------------------------------------------------
// 1. Empty window → null value, zero sample count
// ---------------------------------------------------------------------------

describe('computeFailureRate — empty window', () => {
  it('returns value=null and sampleCount=0 when no tasks in window', async () => {
    const store = await makeStore()

    const result = await computeFailureRate(store, WINDOW)

    expect(result.value).toBeNull()
    expect(result.sampleCount).toBe(0)
  })

  it('ignores tasks outside the window', async () => {
    const store = await makeStore()
    await insertTask(store, {
      id: 'old-task',
      status: 'done',
      updated_at: '2025-12-01T00:00:00Z', // before window
    })

    const result = await computeFailureRate(store, WINDOW)

    expect(result.value).toBeNull()
    expect(result.sampleCount).toBe(0)
  })

  it('ignores non-terminal tasks (queued, running, etc.)', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'running-task', status: 'running' })
    await insertTask(store, { id: 'queued-task', status: 'queued' })

    const result = await computeFailureRate(store, WINDOW)

    expect(result.value).toBeNull()
    expect(result.sampleCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Failure rate math
// ---------------------------------------------------------------------------

describe('computeFailureRate — failure rate calculation', () => {
  it('returns 0 when all arcs are done', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-1', status: 'done' })
    await insertTask(store, { id: 'task-2', status: 'done' })
    await insertTask(store, { id: 'task-3', status: 'done' })

    const result = await computeFailureRate(store, WINDOW)

    expect(result.value).toBe(0)
    expect(result.sampleCount).toBe(3)
  })

  it('returns 1 when all arcs are failed', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-1', status: 'failed' })
    await insertTask(store, { id: 'task-2', status: 'failed' })

    const result = await computeFailureRate(store, WINDOW)

    expect(result.value).toBe(1)
    expect(result.sampleCount).toBe(2)
  })

  it('computes failure_rate = failed / (done + failed)', async () => {
    const store = await makeStore()
    // 2 done, 2 failed → rate = 2/4 = 0.5
    await insertTask(store, { id: 'task-done-1', status: 'done' })
    await insertTask(store, { id: 'task-done-2', status: 'done' })
    await insertTask(store, { id: 'task-fail-1', status: 'failed' })
    await insertTask(store, { id: 'task-fail-2', status: 'failed' })

    const result = await computeFailureRate(store, WINDOW)

    expect(result.value).toBeCloseTo(0.5, 10)
    expect(result.sampleCount).toBe(4)
  })

  it('computes correct rate with 1 failed out of 5', async () => {
    const store = await makeStore()
    // 4 done, 1 failed → rate = 1/5 = 0.2
    await insertTask(store, { id: 't1', status: 'done' })
    await insertTask(store, { id: 't2', status: 'done' })
    await insertTask(store, { id: 't3', status: 'done' })
    await insertTask(store, { id: 't4', status: 'done' })
    await insertTask(store, { id: 't5', status: 'failed' })

    const result = await computeFailureRate(store, WINDOW)

    expect(result.value).toBeCloseTo(0.2, 10)
    expect(result.sampleCount).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 3. Arc-level grouping (recovery tasks share origin_id)
// ---------------------------------------------------------------------------

describe('computeFailureRate — arc-level grouping', () => {
  it('counts an arc as done when any task in it reached done', async () => {
    const store = await makeStore()
    // Arc "arc-1": origin failed, recovery done → arc is done
    await insertTask(store, { id: 'arc-1-origin', status: 'failed', origin_id: null })
    await insertTask(store, {
      id: 'arc-1-recovery',
      status: 'done',
      origin_id: 'arc-1-origin',
    })

    const result = await computeFailureRate(store, WINDOW)

    // Only 1 arc (arc-1-origin), and it has a done task, so failure_rate = 0
    expect(result.value).toBe(0)
    expect(result.sampleCount).toBe(1)
  })

  it('counts an arc as failed when no task in it reached done', async () => {
    const store = await makeStore()
    // Arc "arc-2": origin failed, recovery also failed → arc is failed
    await insertTask(store, { id: 'arc-2-origin', status: 'failed', origin_id: null })
    await insertTask(store, {
      id: 'arc-2-recovery',
      status: 'failed',
      origin_id: 'arc-2-origin',
    })

    const result = await computeFailureRate(store, WINDOW)

    expect(result.value).toBe(1)
    expect(result.sampleCount).toBe(1)
  })

  it('counts mixed arcs correctly', async () => {
    const store = await makeStore()
    // Arc 1: just done → done arc
    await insertTask(store, { id: 'a1', status: 'done', origin_id: null })

    // Arc 2: origin failed, recovery done → done arc
    await insertTask(store, { id: 'a2', status: 'failed', origin_id: null })
    await insertTask(store, { id: 'a2-fix', status: 'done', origin_id: 'a2' })

    // Arc 3: fully failed → failed arc
    await insertTask(store, { id: 'a3', status: 'failed', origin_id: null })

    // 2 done arcs, 1 failed arc → rate = 1/3
    const result = await computeFailureRate(store, WINDOW)

    expect(result.sampleCount).toBe(3)
    expect(result.value).toBeCloseTo(1 / 3, 5)
  })
})

// ---------------------------------------------------------------------------
// 4. cacheWeightedTokens — formula is: input + output + cache_create + cache_read * 0.1
// ---------------------------------------------------------------------------

describe('cacheWeightedTokens', () => {
  it('weights cache reads at 0.1x and all other tokens at 1x', () => {
    expect(
      cacheWeightedTokens({
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreateTokens: 200,
        cacheReadTokens: 10000,
      }),
    ).toBeCloseTo(1000 + 500 + 200 + 10000 * 0.1, 10)
  })

  it('returns 0 for all-zero usage', () => {
    expect(
      cacheWeightedTokens({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. computeCostPerArcDistribution — empty window
// ---------------------------------------------------------------------------

describe('computeCostPerArcDistribution — empty window', () => {
  it('returns p50=null, p90=null, sampleCount=0 when no done arcs', async () => {
    const store = await makeStore()

    const result = await computeCostPerArcDistribution(store, WINDOW)

    expect(result.p50).toBeNull()
    expect(result.p90).toBeNull()
    expect(result.sampleCount).toBe(0)
  })

  it('excludes failed arcs from the distribution', async () => {
    const store = await makeStore()
    // Arc that is entirely failed — must NOT contribute to cost distribution
    await insertTask(store, { id: 'failed-arc', status: 'failed' })
    await insertSignal(store, { taskId: 'failed-arc', inputTokens: 5000 })

    const result = await computeCostPerArcDistribution(store, WINDOW)

    expect(result.p50).toBeNull()
    expect(result.p90).toBeNull()
    expect(result.sampleCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. computeAutonomousCompletionRate
// ---------------------------------------------------------------------------

describe('computeAutonomousCompletionRate — empty window', () => {
  it('returns value=null and sampleCount=0 when no done arcs in window', async () => {
    const store = await makeStore()

    const result = await computeAutonomousCompletionRate(store, WINDOW)

    expect(result.value).toBeNull()
    expect(result.sampleCount).toBe(0)
  })

  it('ignores failed-only arcs (no done tasks in window)', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'f1', status: 'failed' })
    await insertTask(store, { id: 'f2', status: 'failed' })

    const result = await computeAutonomousCompletionRate(store, WINDOW)

    expect(result.value).toBeNull()
    expect(result.sampleCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 7. computeCostPerArcDistribution — single-Arc window: p50 === p90
// ---------------------------------------------------------------------------

describe('computeCostPerArcDistribution — single Arc', () => {
  it('yields p50 === p90 when there is exactly one done Arc', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'arc-solo', status: 'done' })
    await insertSignal(store, { taskId: 'arc-solo', inputTokens: 1000 })

    const result = await computeCostPerArcDistribution(store, WINDOW)

    expect(result.sampleCount).toBe(1)
    expect(result.p50).not.toBeNull()
    expect(result.p90).not.toBeNull()
    expect(result.p50).toBe(result.p90)
    expect(result.p50).toBeCloseTo(1000, 10)
  })
})

// ---------------------------------------------------------------------------
// 8. computeCostPerArcDistribution — percentile math on a skewed distribution
// ---------------------------------------------------------------------------

describe('computeCostPerArcDistribution — percentile math', () => {
  it('p50 < p90 on a skewed cost distribution', async () => {
    const store = await makeStore()
    // 4 cheap arcs + 1 very expensive arc → highly right-skewed
    for (let i = 1; i <= 4; i++) {
      await insertTask(store, { id: `cheap-${i}`, status: 'done' })
      await insertSignal(store, { taskId: `cheap-${i}`, inputTokens: 100 })
    }
    await insertTask(store, { id: 'expensive', status: 'done' })
    await insertSignal(store, { taskId: 'expensive', inputTokens: 10000 })

    const result = await computeCostPerArcDistribution(store, WINDOW)

    expect(result.sampleCount).toBe(5)
    expect(result.p50).not.toBeNull()
    expect(result.p90).not.toBeNull()
    expect(result.p50!).toBeLessThan(result.p90!)
  })

  it('computes correct interpolated percentiles', async () => {
    const store = await makeStore()
    // Costs: [100, 200, 400] — sorted, n=3
    // p50 index = 0.5 * 2 = 1.0 → sorted[1] = 200
    // p90 index = 0.9 * 2 = 1.8 → sorted[1] + 0.8*(sorted[2]-sorted[1]) = 200 + 0.8*200 = 360
    await insertTask(store, { id: 'arc-a', status: 'done' })
    await insertSignal(store, { taskId: 'arc-a', inputTokens: 100 })

    await insertTask(store, { id: 'arc-b', status: 'done' })
    await insertSignal(store, { taskId: 'arc-b', inputTokens: 200 })

    await insertTask(store, { id: 'arc-c', status: 'done' })
    await insertSignal(store, { taskId: 'arc-c', inputTokens: 400 })

    const result = await computeCostPerArcDistribution(store, WINDOW)

    expect(result.sampleCount).toBe(3)
    expect(result.p50).toBeCloseTo(200, 10)
    expect(result.p90).toBeCloseTo(360, 10)
  })

  it('sums costs across all tasks in a multi-task Arc', async () => {
    const store = await makeStore()
    // Arc with origin + recovery: costs should be summed
    await insertTask(store, { id: 'multi-origin', status: 'failed', origin_id: null })
    await insertSignal(store, { taskId: 'multi-origin', inputTokens: 300 })
    await insertTask(store, {
      id: 'multi-recovery',
      status: 'done',
      origin_id: 'multi-origin',
    })
    await insertSignal(store, { taskId: 'multi-recovery', inputTokens: 700 })

    const result = await computeCostPerArcDistribution(store, WINDOW)

    expect(result.sampleCount).toBe(1)
    // Total cost = 300 + 700 = 1000
    expect(result.p50).toBeCloseTo(1000, 10)
  })
})

// ---------------------------------------------------------------------------
// 9. computeAutonomousCompletionRate — fixture cases
// ---------------------------------------------------------------------------

describe('computeAutonomousCompletionRate — fixture cases', () => {
  it('clean done-Arc IS counted as autonomous', async () => {
    const store = await makeStore()
    // Single task: done, no recovery edge, no inbox item
    await insertTask(store, { id: 'clean-arc', status: 'done' })

    const result = await computeAutonomousCompletionRate(store, WINDOW)

    expect(result.sampleCount).toBe(1)
    expect(result.value).toBe(1)
  })

  it('Arc with a fix_for_task_id task in its tree is NOT counted as autonomous', async () => {
    const store = await makeStore()
    // Origin task reached done via a recovery task
    await insertTask(store, {
      id: 'origin-task',
      status: 'failed',
      origin_id: null,
    })
    await insertTask(store, {
      id: 'fix-task',
      status: 'done',
      origin_id: 'origin-task',
      fix_for_task_id: 'origin-task',
    })

    const result = await computeAutonomousCompletionRate(store, WINDOW)

    // 1 done arc, 0 autonomous → value = 0
    expect(result.sampleCount).toBe(1)
    expect(result.value).toBe(0)
  })

  it('Arc with a task-blocked inbox item is NOT counted as autonomous', async () => {
    const store = await makeStore()
    // Task reached done but had a task-blocked action-queue item raised against it
    await insertTask(store, {
      id: 'blocked-arc',
      status: 'done',
    })
    await store.execute({
      sql: `INSERT INTO action_queue_items (id, kind, origin_task_id)
            VALUES (?, 'task-blocked', ?)`,
      args: ['aq-item-1', 'blocked-arc'],
    })

    const result = await computeAutonomousCompletionRate(store, WINDOW)

    // 1 done arc, 0 autonomous (had a task-blocked item) → value = 0
    expect(result.sampleCount).toBe(1)
    expect(result.value).toBe(0)
  })

  it('only non-disqualified done arcs count toward autonomous rate', async () => {
    const store = await makeStore()
    // Arc A: clean done → autonomous
    await insertTask(store, { id: 'arc-a', status: 'done' })

    // Arc B: done but has recovery task → NOT autonomous
    await insertTask(store, { id: 'arc-b-origin', status: 'failed' })
    await insertTask(store, {
      id: 'arc-b-fix',
      status: 'done',
      origin_id: 'arc-b-origin',
      fix_for_task_id: 'arc-b-origin',
    })

    // Arc C: done but has task-blocked item → NOT autonomous
    await insertTask(store, { id: 'arc-c', status: 'done' })
    await store.execute({
      sql: `INSERT INTO action_queue_items (id, kind, origin_task_id)
            VALUES (?, 'task-blocked', ?)`,
      args: ['aq-item-2', 'arc-c'],
    })

    // sampleCount = 3 (arc-a, arc-b-origin, arc-c all have done tasks in window)
    // autonomous = 1 (arc-a only)
    // value = 1/3
    const result = await computeAutonomousCompletionRate(store, WINDOW)

    expect(result.sampleCount).toBe(3)
    expect(result.value).toBeCloseTo(1 / 3, 5)
  })
})

// ---------------------------------------------------------------------------
// 10. computeRecoverySuccessRate
// ---------------------------------------------------------------------------

describe('computeRecoverySuccessRate — empty window', () => {
  it('returns value=null and sampleCount=0 when no recovery tasks in window', async () => {
    const store = await makeStore()

    const result = await computeRecoverySuccessRate(store, WINDOW)

    expect(result.value).toBeNull()
    expect(result.sampleCount).toBe(0)
  })

  it('ignores recovery tasks outside the window', async () => {
    const store = await makeStore()
    // Recovery task completed before window start
    await insertTask(store, { id: 'origin-old', status: 'done', origin_id: null })
    await insertTask(store, {
      id: 'fix-old',
      status: 'done',
      origin_id: 'origin-old',
      fix_for_task_id: 'origin-old',
      updated_at: '2025-12-01T00:00:00Z',
    })

    const result = await computeRecoverySuccessRate(store, WINDOW)

    expect(result.value).toBeNull()
    expect(result.sampleCount).toBe(0)
  })
})

describe('computeRecoverySuccessRate — success-and-failure fixture', () => {
  it('value === 0.5 and sampleCount === 2 for one success and one failure', async () => {
    const store = await makeStore()

    // Arc 1: recovery succeeded → origin flipped to done
    await insertTask(store, {
      id: 'origin-1',
      status: 'done',
      origin_id: null,
      updated_at: '2026-01-04T12:00:00Z',
    })
    await insertTask(store, {
      id: 'fix-1',
      status: 'done',
      origin_id: 'origin-1',
      fix_for_task_id: 'origin-1',
      updated_at: '2026-01-04T12:00:00Z',
    })

    // Arc 2: recovery failed → origin stays failed
    await insertTask(store, {
      id: 'origin-2',
      status: 'failed',
      origin_id: null,
      updated_at: '2026-01-04T12:00:00Z',
    })
    await insertTask(store, {
      id: 'fix-2',
      status: 'failed',
      origin_id: 'origin-2',
      fix_for_task_id: 'origin-2',
      updated_at: '2026-01-04T12:00:00Z',
    })

    const result = await computeRecoverySuccessRate(store, WINDOW)

    expect(result.value).toBeCloseTo(0.5, 10)
    expect(result.sampleCount).toBe(2)
  })

  it('returns value=0 when all recoveries failed', async () => {
    const store = await makeStore()

    await insertTask(store, { id: 'origin-a', status: 'failed' })
    await insertTask(store, {
      id: 'fix-a',
      status: 'failed',
      origin_id: 'origin-a',
      fix_for_task_id: 'origin-a',
    })

    const result = await computeRecoverySuccessRate(store, WINDOW)

    expect(result.value).toBe(0)
    expect(result.sampleCount).toBe(1)
  })

  it('returns value=1 when all recoveries succeeded', async () => {
    const store = await makeStore()

    await insertTask(store, { id: 'origin-b', status: 'done' })
    await insertTask(store, {
      id: 'fix-b',
      status: 'done',
      origin_id: 'origin-b',
      fix_for_task_id: 'origin-b',
    })

    const result = await computeRecoverySuccessRate(store, WINDOW)

    expect(result.value).toBe(1)
    expect(result.sampleCount).toBe(1)
  })
})
