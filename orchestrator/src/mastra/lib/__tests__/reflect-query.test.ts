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

const TASK_SIGNALS_DDL = `
  CREATE TABLE IF NOT EXISTS task_signals (
    task_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_create_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (task_id, step_id)
  )
`

const makeStore = async (): Promise<TaskStore> => {
  const client = openLibsql({ url: `file:${tmpDbPath()}` })
  await client.execute(TASKS_DDL)
  await client.execute(TASK_SIGNALS_DDL)
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
    totalCostUsd?: number
    messageCount?: number
  },
): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO task_signals
            (task_id, step_id, input_tokens, output_tokens,
             cache_create_tokens, cache_read_tokens, total_cost_usd,
             message_count, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      opts.taskId,
      opts.stepId,
      opts.inputTokens ?? 0,
      opts.outputTokens ?? 0,
      opts.cacheCreateTokens ?? 0,
      opts.cacheReadTokens ?? 0,
      opts.totalCostUsd ?? 0,
      opts.messageCount ?? 0,
      '2026-01-01T00:00:01Z',
    ],
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
    expect(corpus.costSummary.totalCostUsd).toBe(0)
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
      totalCostUsd: 0.05,
    })

    const corpus = await loadRecentTaskCorpus({ store })

    expect(corpus.entries).toHaveLength(1)
    const entry = corpus.entries[0]
    expect(entry.totals.inputTokens).toBe(1000)
    expect(entry.totals.outputTokens).toBe(500)
    expect(entry.totals.cacheCreateTokens).toBe(200)
    expect(entry.totals.cacheReadTokens).toBe(100)
    expect(entry.totals.totalCostUsd).toBeCloseTo(0.05)
  })

  it('sums signal tokens across multiple steps for one task', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-multi', status: 'done' })
    await insertSignal(store, {
      taskId: 'task-multi',
      stepId: 'code',
      inputTokens: 1000,
      outputTokens: 200,
      totalCostUsd: 0.03,
    })
    await insertSignal(store, {
      taskId: 'task-multi',
      stepId: 'verify',
      inputTokens: 500,
      outputTokens: 100,
      totalCostUsd: 0.01,
    })

    const corpus = await loadRecentTaskCorpus({ store })

    const entry = corpus.entries[0]
    expect(entry.totals.inputTokens).toBe(1500)
    expect(entry.totals.outputTokens).toBe(300)
    expect(entry.totals.totalCostUsd).toBeCloseTo(0.04)
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
    await insertSignal(store, { taskId: 'task-a', stepId: 'code', totalCostUsd: 0.10 })
    await insertSignal(store, { taskId: 'task-b', stepId: 'code', totalCostUsd: 0.05 })

    const corpus = await loadRecentTaskCorpus({ store })

    expect(corpus.costSummary.taskCount).toBe(2)
    expect(corpus.costSummary.successCount).toBe(1)
    expect(corpus.costSummary.failureCount).toBe(1)
    expect(corpus.costSummary.totalCostUsd).toBeCloseTo(0.15)
  })
})
