import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openLibsql } from '../libsql'
import { createLibsqlTaskStore, type TaskStore } from '../task-store'
import { loadRecentTaskCorpus } from '../reflect-query'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-reflect-query-'))
  return join(dir, 'queue.db')
}

const TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`

// After PRD 436f14c7 slice 5, signals live in trace_events, not task_signals.
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
  const client = openLibsql({ url: `file:${tmpDbPath()}` })
  await client.execute(TASKS_DDL)
  await client.execute(TRACE_EVENTS_DDL)
  return createLibsqlTaskStore(client)
}

const insertTask = async (
  store: TaskStore,
  opts: {
    id: string
    prompt?: string
    status: string
    error?: string | null
    createdAt?: string
  },
): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO tasks (id, prompt, status, error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      opts.id,
      opts.prompt ?? 'do the thing',
      opts.status,
      opts.error ?? null,
      opts.createdAt ?? '2026-01-01T00:00:00Z',
      opts.createdAt ?? '2026-01-01T00:00:00Z',
    ],
  })
}

const insertSignal = async (
  store: TaskStore,
  opts: {
    taskId: string
    stepId: string
    inputTokens?: number
    outputTokens?: number
    cacheCreateTokens?: number
    cacheReadTokens?: number
    messageCount?: number
  },
): Promise<void> => {
  // After PRD 436f14c7 slice 5, signals are stored as step_ended trace events.
  const payload = JSON.stringify({
    stepName: opts.stepId,
    workflowInstanceId: `test-${opts.taskId}-${opts.stepId}`,
    outcome: 'success',
    durationMs: 0,
    usageSignals: {
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
      cacheCreateTokens: opts.cacheCreateTokens ?? 0,
      cacheReadTokens: opts.cacheReadTokens ?? 0,
      messageCount: opts.messageCount ?? 0,
    },
  })
  await store.execute({
    sql: `INSERT OR REPLACE INTO trace_events
            (id, timestamp, kind, severity, task_id, payload)
          VALUES (?, ?, 'step_ended', 'info', ?, ?)`,
    args: [`test-${opts.taskId}-${opts.stepId}`, '2026-01-01T00:00:01Z', opts.taskId, payload],
  })
}

describe('loadRecentTaskCorpus', () => {
  it('returns empty corpus when there are no completed tasks', async () => {
    const store = await makeStore()
    // insert a queued task that should be excluded
    await insertTask(store, { id: 'task-queued', status: 'queued' })

    const corpus = await loadRecentTaskCorpus({ store })

    expect(corpus.entries).toHaveLength(0)
    expect(corpus.costSummary.taskCount).toBe(0)
    expect(corpus.costSummary.totalWeightedTokens).toBe(0)
  })

  it('returns entries for done and failed tasks', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-done', status: 'done', createdAt: '2026-01-02T00:00:00Z' })
    await insertTask(store, { id: 'task-failed', status: 'failed', createdAt: '2026-01-01T00:00:00Z' })
    await insertTask(store, { id: 'task-queued', status: 'queued', createdAt: '2026-01-03T00:00:00Z' })

    const corpus = await loadRecentTaskCorpus({ store })

    const ids = corpus.entries.map((e) => e.taskId)
    expect(ids).toContain('task-done')
    expect(ids).toContain('task-failed')
    expect(ids).not.toContain('task-queued')
  })

  it('accumulates token totals from signals into each entry', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-1', status: 'done' })
    await insertSignal(store, {
      taskId: 'task-1',
      stepId: 'code',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreateTokens: 200,
      cacheReadTokens: 100,
    })

    const corpus = await loadRecentTaskCorpus({ store })

    expect(corpus.entries).toHaveLength(1)
    const entry = corpus.entries[0]
    expect(entry.totals.inputTokens).toBe(1000)
    expect(entry.totals.outputTokens).toBe(500)
    expect(entry.totals.cacheCreateTokens).toBe(200)
    expect(entry.totals.cacheReadTokens).toBe(100)
  })

  it('sums signal tokens across multiple steps for one task', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-multi', status: 'done' })
    await insertSignal(store, {
      taskId: 'task-multi',
      stepId: 'code',
      inputTokens: 1000,
      outputTokens: 200,
    })
    await insertSignal(store, {
      taskId: 'task-multi',
      stepId: 'verify',
      inputTokens: 500,
      outputTokens: 100,
    })

    const corpus = await loadRecentTaskCorpus({ store })

    const entry = corpus.entries[0]
    expect(entry.totals.inputTokens).toBe(1500)
    expect(entry.totals.outputTokens).toBe(300)
    expect(entry.signals).toHaveLength(2)
  })

  it('respects the sinceIso filter', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-old', status: 'done', createdAt: '2026-01-01T00:00:00Z' })
    await insertTask(store, { id: 'task-new', status: 'done', createdAt: '2026-02-01T00:00:00Z' })

    const corpus = await loadRecentTaskCorpus({
      store,
      sinceIso: '2026-01-15T00:00:00Z',
    })

    const ids = corpus.entries.map((e) => e.taskId)
    expect(ids).not.toContain('task-old')
    expect(ids).toContain('task-new')
  })

  it('respects the limit option', async () => {
    const store = await makeStore()
    for (let i = 1; i <= 5; i++) {
      await insertTask(store, {
        id: `task-${i}`,
        status: 'done',
        createdAt: `2026-01-0${i}T00:00:00Z`,
      })
    }

    const corpus = await loadRecentTaskCorpus({ store, limit: 3 })

    expect(corpus.entries).toHaveLength(3)
  })

  it('includes promptPrefix truncated from the prompt column', async () => {
    const store = await makeStore()
    const longPrompt = 'A'.repeat(300)
    await insertTask(store, { id: 'task-prompt', status: 'done', prompt: longPrompt })

    const corpus = await loadRecentTaskCorpus({ store })

    const entry = corpus.entries[0]
    // PROMPT_PREFIX_BYTES = 200; truncated result ends with ellipsis
    expect(entry.promptPrefix.length).toBeLessThan(longPrompt.length)
    expect(entry.promptPrefix.endsWith('…')).toBe(true)
  })

  it('populates costSummary from entries', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-a', status: 'done' })
    await insertTask(store, { id: 'task-b', status: 'failed' })
    await insertSignal(store, { taskId: 'task-a', stepId: 'code', inputTokens: 1000 })
    await insertSignal(store, { taskId: 'task-b', stepId: 'code', inputTokens: 500 })

    const corpus = await loadRecentTaskCorpus({ store })

    expect(corpus.costSummary.taskCount).toBe(2)
    expect(corpus.costSummary.successCount).toBe(1)
    expect(corpus.costSummary.failureCount).toBe(1)
    // weighted_tokens = input*1 + output*1 + cache_create*1 + cache_read*0.1
    // task-a: 1000, task-b: 500, total: 1500
    expect(corpus.costSummary.totalWeightedTokens).toBeCloseTo(1500)
  })
})
