import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openLibsql } from '../libsql.js'
import { createLibsqlTaskStore, type TaskStore } from '../task-store.js'
import { computeFailureRate } from '../kpi-compute.js'

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

const makeStore = async (): Promise<TaskStore> => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-kpi-compute-'))
  const client = openLibsql({ url: `file:${join(dir, 'queue.db')}` })
  await client.execute(TASKS_DDL)
  return createLibsqlTaskStore(client)
}

const insertTask = async (
  store: TaskStore,
  opts: {
    id: string
    status: string
    origin_id?: string | null
    updated_at?: string
  },
): Promise<void> => {
  await store.execute({
    sql: 'INSERT INTO tasks (id, status, origin_id, updated_at) VALUES (?, ?, ?, ?)',
    args: [
      opts.id,
      opts.status,
      opts.origin_id ?? null,
      opts.updated_at ?? '2026-01-04T12:00:00Z',
    ],
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
