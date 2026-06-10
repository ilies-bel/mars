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
  listAutonomousArcs,
  listCostPerArcArcs,
  listFailureRateArcs,
  listRecoveryArcs,
} from '../kpi-compute.js'

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

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
    prompt?: string | null
    status: string
    origin_id?: string | null
    fix_for_task_id?: string | null
    updated_at?: string
  },
): Promise<void> => {
  await store.execute({
    sql: 'INSERT INTO tasks (id, prompt, status, origin_id, fix_for_task_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: [
      opts.id,
      opts.prompt ?? null,
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
// 9a. computeCostPerArcDistribution — dangling-origin join-reachability fix
// ---------------------------------------------------------------------------

describe('computeCostPerArcDistribution — dangling-origin arc', () => {
  it('recovers cost when trace_events are keyed by the arc/origin id with no matching task row', async () => {
    const store = await makeStore()
    // Arc 'dangling-origin': there is NO task row with id='dangling-origin'.
    // Only a member task with origin_id='dangling-origin' exists.
    // The trace event is stored under te.task_id='dangling-origin' (the arc id),
    // which is the pattern for usage signals captured during the arc's run.
    await insertTask(store, {
      id: 'member-task',
      status: 'done',
      origin_id: 'dangling-origin',
    })
    await insertSignal(store, { taskId: 'dangling-origin', inputTokens: 500 })

    const result = await computeCostPerArcDistribution(store, WINDOW)

    expect(result.sampleCount).toBe(1)
    expect(result.p50).toBeCloseTo(500, 10)
  })

  it('does not double-count when one signal is member-keyed and another is arc-keyed', async () => {
    const store = await makeStore()
    // Arc 'arc-mixed' has a member task with a member-keyed signal AND
    // a separate arc-keyed signal (dangling-origin pattern).
    // The two signals must be summed once each; neither should be counted twice.
    await insertTask(store, {
      id: 'arc-mixed-member',
      status: 'done',
      origin_id: 'arc-mixed',
    })
    // Member-keyed signal: 200 tokens
    await insertSignal(store, { taskId: 'arc-mixed-member', inputTokens: 200 })
    // Arc-keyed signal: 300 tokens (dangling-origin pattern)
    await insertSignal(store, { taskId: 'arc-mixed', inputTokens: 300 })

    const result = await computeCostPerArcDistribution(store, WINDOW)

    expect(result.sampleCount).toBe(1)
    // Total must be 200 + 300 = 500, not 200 + 300 + 300 (no double-count)
    expect(result.p50).toBeCloseTo(500, 10)
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

// ---------------------------------------------------------------------------
// 11. listFailureRateArcs — mirrors computeFailureRate arc grouping
// ---------------------------------------------------------------------------

describe('listFailureRateArcs', () => {
  it('returns empty array when no terminal tasks in window', async () => {
    const store = await makeStore()
    const arcs = await listFailureRateArcs(store, WINDOW)
    expect(arcs).toHaveLength(0)
  })

  it('marks a done arc as passed', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'arc-done', status: 'done' })
    const arcs = await listFailureRateArcs(store, WINDOW)
    expect(arcs).toHaveLength(1)
    expect(arcs[0].passed).toBe(true)
    expect(arcs[0].status).toBe('done')
    expect(arcs[0].arcId).toBe('arc-done')
  })

  it('marks a failed arc as not passed', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'arc-fail', status: 'failed' })
    const arcs = await listFailureRateArcs(store, WINDOW)
    expect(arcs).toHaveLength(1)
    expect(arcs[0].passed).toBe(false)
    expect(arcs[0].status).toBe('failed')
  })

  it('groups origin + recovery into one arc, passed when recovery succeeded', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'origin', status: 'failed', origin_id: null })
    await insertTask(store, { id: 'recovery', status: 'done', origin_id: 'origin' })

    const arcs = await listFailureRateArcs(store, WINDOW)
    // One arc (grouped by COALESCE(origin_id, id) = 'origin')
    expect(arcs).toHaveLength(1)
    expect(arcs[0].arcId).toBe('origin')
    expect(arcs[0].passed).toBe(true)
  })

  it('arc count matches computeFailureRate sampleCount', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'd1', status: 'done' })
    await insertTask(store, { id: 'd2', status: 'done' })
    await insertTask(store, { id: 'f1', status: 'failed' })

    const arcs = await listFailureRateArcs(store, WINDOW)
    const compute = await computeFailureRate(store, WINDOW)

    expect(arcs).toHaveLength(compute.sampleCount)
    const failedCount = arcs.filter((a) => !a.passed).length
    const total = arcs.length
    expect(failedCount / total).toBeCloseTo(compute.value!, 10)
  })
})

// ---------------------------------------------------------------------------
// 12. listAutonomousArcs — mirrors computeAutonomousCompletionRate
// ---------------------------------------------------------------------------

describe('listAutonomousArcs', () => {
  it('returns empty array when no done arcs in window', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'f1', status: 'failed' })
    const arcs = await listAutonomousArcs(store, WINDOW)
    expect(arcs).toHaveLength(0)
  })

  it('marks a clean done arc as passed (autonomous)', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'clean', status: 'done' })
    const arcs = await listAutonomousArcs(store, WINDOW)
    expect(arcs).toHaveLength(1)
    expect(arcs[0].passed).toBe(true)
  })

  it('marks an arc with a fix task as not passed', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'origin', status: 'failed' })
    await insertTask(store, {
      id: 'fix',
      status: 'done',
      origin_id: 'origin',
      fix_for_task_id: 'origin',
    })
    const arcs = await listAutonomousArcs(store, WINDOW)
    expect(arcs).toHaveLength(1)
    expect(arcs[0].passed).toBe(false)
  })

  it('arc + passed counts match computeAutonomousCompletionRate value/sampleCount', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'auto', status: 'done' })
    await insertTask(store, { id: 'orig2', status: 'failed' })
    await insertTask(store, { id: 'fix2', status: 'done', origin_id: 'orig2', fix_for_task_id: 'orig2' })

    const arcs = await listAutonomousArcs(store, WINDOW)
    const compute = await computeAutonomousCompletionRate(store, WINDOW)

    expect(arcs).toHaveLength(compute.sampleCount)
    const autonomousCount = arcs.filter((a) => a.passed).length
    expect(autonomousCount / arcs.length).toBeCloseTo(compute.value!, 10)
  })
})

// ---------------------------------------------------------------------------
// 13. listRecoveryArcs — mirrors computeRecoverySuccessRate
// ---------------------------------------------------------------------------

describe('listRecoveryArcs', () => {
  it('returns empty array when no recovery tasks in window', async () => {
    const store = await makeStore()
    const arcs = await listRecoveryArcs(store, WINDOW)
    expect(arcs).toHaveLength(0)
  })

  it('marks a successful recovery as passed', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'orig', status: 'done' })
    await insertTask(store, { id: 'fix', status: 'done', origin_id: 'orig', fix_for_task_id: 'orig' })
    const arcs = await listRecoveryArcs(store, WINDOW)
    expect(arcs).toHaveLength(1)
    expect(arcs[0].passed).toBe(true)
    expect(arcs[0].originTaskId).toBe('orig')
  })

  it('marks a failed recovery as not passed', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'orig', status: 'failed' })
    await insertTask(store, { id: 'fix', status: 'failed', origin_id: 'orig', fix_for_task_id: 'orig' })
    const arcs = await listRecoveryArcs(store, WINDOW)
    expect(arcs).toHaveLength(1)
    expect(arcs[0].passed).toBe(false)
  })

  it('row count and pass rate match computeRecoverySuccessRate', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'o1', status: 'done' })
    await insertTask(store, { id: 'r1', status: 'done', origin_id: 'o1', fix_for_task_id: 'o1' })
    await insertTask(store, { id: 'o2', status: 'failed' })
    await insertTask(store, { id: 'r2', status: 'failed', origin_id: 'o2', fix_for_task_id: 'o2' })

    const arcs = await listRecoveryArcs(store, WINDOW)
    const compute = await computeRecoverySuccessRate(store, WINDOW)

    expect(arcs).toHaveLength(compute.sampleCount)
    const passed = arcs.filter((a) => a.passed).length
    expect(passed / arcs.length).toBeCloseTo(compute.value!, 10)
  })
})

// ---------------------------------------------------------------------------
// 14. listCostPerArcArcs — mirrors computeCostPerArcDistribution
// ---------------------------------------------------------------------------

describe('listCostPerArcArcs', () => {
  it('returns empty array when no done arcs', async () => {
    const store = await makeStore()
    const arcs = await listCostPerArcArcs(store, WINDOW)
    expect(arcs).toHaveLength(0)
  })

  it('returns one row per done arc with costTokens set', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'arc1', status: 'done' })
    await insertSignal(store, { taskId: 'arc1', inputTokens: 1000 })
    await insertTask(store, { id: 'arc2', status: 'done' })
    await insertSignal(store, { taskId: 'arc2', inputTokens: 2000 })

    const arcs = await listCostPerArcArcs(store, WINDOW)
    expect(arcs).toHaveLength(2)
    for (const arc of arcs) {
      expect(arc.passed).toBe(true)
      expect(arc.costTokens).toBeDefined()
      expect(arc.costTokens).toBeGreaterThan(0)
    }
  })

  it('row count matches computeCostPerArcDistribution sampleCount', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'a1', status: 'done' })
    await insertSignal(store, { taskId: 'a1', inputTokens: 100 })
    await insertTask(store, { id: 'a2', status: 'done' })
    await insertSignal(store, { taskId: 'a2', inputTokens: 200 })

    const arcs = await listCostPerArcArcs(store, WINDOW)
    const compute = await computeCostPerArcDistribution(store, WINDOW)

    expect(arcs).toHaveLength(compute.sampleCount)
  })

  it('all arcs have passed=true (cost_per_arc has no pass/fail)', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'arc', status: 'done' })
    const arcs = await listCostPerArcArcs(store, WINDOW)
    expect(arcs.every((a) => a.passed)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 15. dangling-origin arcs — originTaskId must resolve to a real member task
// ---------------------------------------------------------------------------
// A "dangling origin" is an arc whose arc_id (= COALESCE(origin_id, id))
// has no backing `tasks` row. Member tasks carry origin_id = arc_id, but no
// task has id = arc_id. All three list* helpers must return:
//   • originTaskId pointing at an existing tasks row (not the dangling arc_id)
//   • title non-empty when the member task has a prompt
// ---------------------------------------------------------------------------

describe('dangling-origin arcs', () => {
  it('listCostPerArcArcs: originTaskId resolves to real member, title populated', async () => {
    const store = await makeStore()
    // 'dangling-slug' is the arc_id, but no task has id = 'dangling-slug'
    await insertTask(store, {
      id: 'member-task',
      prompt: 'do something useful',
      status: 'done',
      origin_id: 'dangling-slug',
    })
    await insertSignal(store, { taskId: 'member-task', inputTokens: 500 })

    const arcs = await listCostPerArcArcs(store, WINDOW)
    expect(arcs).toHaveLength(1)
    const arc = arcs[0]
    expect(arc.arcId).toBe('dangling-slug')
    // originTaskId must be a real tasks row, not the dangling arc_id
    expect(arc.originTaskId).toBe('member-task')
    expect(arc.title).toBe('do something useful')
  })

  it('listFailureRateArcs: originTaskId resolves to real member, title populated', async () => {
    const store = await makeStore()
    await insertTask(store, {
      id: 'member-task',
      prompt: 'do something useful',
      status: 'done',
      origin_id: 'dangling-slug',
    })

    const arcs = await listFailureRateArcs(store, WINDOW)
    expect(arcs).toHaveLength(1)
    const arc = arcs[0]
    expect(arc.arcId).toBe('dangling-slug')
    expect(arc.originTaskId).toBe('member-task')
    expect(arc.title).toBe('do something useful')
  })

  it('listAutonomousArcs: originTaskId resolves to real member, title populated', async () => {
    const store = await makeStore()
    await insertTask(store, {
      id: 'member-task',
      prompt: 'do something useful',
      status: 'done',
      origin_id: 'dangling-slug',
    })

    const arcs = await listAutonomousArcs(store, WINDOW)
    expect(arcs).toHaveLength(1)
    const arc = arcs[0]
    expect(arc.arcId).toBe('dangling-slug')
    expect(arc.originTaskId).toBe('member-task')
    expect(arc.title).toBe('do something useful')
  })

  it('non-dangling arc: originTaskId stays as the origin task id', async () => {
    const store = await makeStore()
    // origin task exists; recovery member task also exists
    await insertTask(store, {
      id: 'real-origin',
      prompt: 'origin prompt',
      status: 'done',
      origin_id: null,
    })
    await insertTask(store, {
      id: 'recovery-task',
      prompt: 'recovery prompt',
      status: 'done',
      origin_id: 'real-origin',
    })

    const failureArcs = await listFailureRateArcs(store, WINDOW)
    expect(failureArcs).toHaveLength(1)
    expect(failureArcs[0].arcId).toBe('real-origin')
    expect(failureArcs[0].originTaskId).toBe('real-origin')
    expect(failureArcs[0].title).toBe('origin prompt')
  })
})
