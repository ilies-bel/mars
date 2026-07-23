import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openLibsql } from '../libsql'
import { createTaskStore, type DomainTaskStore as TaskStore } from '../../store/task-store'
import { loadRecentTaskCorpus } from '../reflect-query'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-reflect-query-'))
  return join(dir, 'queue.db')
}

// Matches the real schema columns we SELECT from tasks.
const TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    failure_signature TEXT,
    failure_reason_code TEXT,
    failed_phase TEXT,
    kind TEXT,
    fix_for_task_id TEXT,
    origin_id TEXT
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
  return createTaskStore(client)
}

const insertTask = async (
  store: TaskStore,
  opts: {
    id: string
    prompt?: string
    status: string
    error?: string | null
    createdAt?: string
    failureSignature?: string | null
    failureReasonCode?: string | null
    failedPhase?: string | null
    kind?: string | null
    fixForTaskId?: string | null
    originId?: string | null
  },
): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO tasks
            (id, prompt, status, error, created_at, updated_at,
             failure_signature, failure_reason_code, failed_phase,
             kind, fix_for_task_id, origin_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      opts.id,
      opts.prompt ?? 'do the thing',
      opts.status,
      opts.error ?? null,
      opts.createdAt ?? '2026-01-01T00:00:00Z',
      opts.createdAt ?? '2026-01-01T00:00:00Z',
      opts.failureSignature ?? null,
      opts.failureReasonCode ?? null,
      opts.failedPhase ?? null,
      opts.kind ?? null,
      opts.fixForTaskId ?? null,
      opts.originId ?? null,
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

const insertToolInvokedError = async (
  store: TaskStore,
  opts: {
    id: string
    taskId: string
    tool: string
    argv?: string[]
    expectsFailure?: boolean
    timestamp?: string
  },
): Promise<void> => {
  const payload = JSON.stringify({
    tool: opts.tool,
    argv: opts.argv ?? [],
    exitCode: 1,
    expectsFailure: opts.expectsFailure ?? false,
    stdout: '',
    stderr: 'error output',
    durationMs: 100,
  })
  await store.execute({
    sql: `INSERT INTO trace_events
            (id, timestamp, kind, severity, task_id, payload)
          VALUES (?, ?, 'tool_invoked', 'error', ?, ?)`,
    args: [
      opts.id,
      opts.timestamp ?? '2026-01-01T00:00:02Z',
      opts.taskId,
      payload,
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

  it('includes blocked tasks in the corpus', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-blocked', status: 'blocked', createdAt: '2026-01-02T00:00:00Z' })
    await insertTask(store, { id: 'task-done', status: 'done', createdAt: '2026-01-01T00:00:00Z' })

    const corpus = await loadRecentTaskCorpus({ store })

    const ids = corpus.entries.map((e) => e.taskId)
    expect(ids).toContain('task-blocked')
    expect(corpus.costSummary.blockedCount).toBe(1)
  })

  it('includes dropped tasks in the corpus', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-dropped', status: 'dropped', createdAt: '2026-01-02T00:00:00Z' })

    const corpus = await loadRecentTaskCorpus({ store })

    const ids = corpus.entries.map((e) => e.taskId)
    expect(ids).toContain('task-dropped')
    expect(corpus.costSummary.droppedCount).toBe(1)
  })

  it('entry carries failure_signature, failure_reason_code, failed_phase, kind, fixForTaskId, originId', async () => {
    const store = await makeStore()
    // Insert the origin task first to satisfy the FK constraint on fix_for_task_id.
    // 'queued' status is excluded from the corpus, so toHaveLength(1) still holds.
    await insertTask(store, {
      id: 'task-origin',
      status: 'queued',
    })
    await insertTask(store, {
      id: 'task-sig',
      status: 'failed',
      failureSignature: 'typecheck_failure',
      failureReasonCode: 'tsc_error',
      failedPhase: 'verify',
      kind: 'auto',
      fixForTaskId: 'task-origin',
      originId: 'task-origin',
    })

    const corpus = await loadRecentTaskCorpus({ store })

    expect(corpus.entries).toHaveLength(1)
    const entry = corpus.entries[0]
    expect(entry.failureSignature).toBe('typecheck_failure')
    expect(entry.failureReasonCode).toBe('tsc_error')
    expect(entry.failedPhase).toBe('verify')
    expect(entry.kind).toBe('auto')
    expect(entry.fixForTaskId).toBe('task-origin')
    expect(entry.originId).toBe('task-origin')
  })

  it('entry carries null signature fields when columns are unset', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-nosig', status: 'done' })

    const corpus = await loadRecentTaskCorpus({ store })

    const entry = corpus.entries[0]
    expect(entry.failureSignature).toBeNull()
    expect(entry.failureReasonCode).toBeNull()
    expect(entry.failedPhase).toBeNull()
    expect(entry.kind).toBeNull()
    expect(entry.fixForTaskId).toBeNull()
    expect(entry.originId).toBeNull()
  })

  it('excludes expectsFailure=true tool_invoked errors from toolErrorCount', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-tool', status: 'done' })
    // This probe is an expected failure — must NOT be counted.
    await insertToolInvokedError(store, {
      id: 'te-probe',
      taskId: 'task-tool',
      tool: 'tsc',
      argv: ['--noEmit'],
      expectsFailure: true,
    })
    // This is a real error — must be counted.
    await insertToolInvokedError(store, {
      id: 'te-real',
      taskId: 'task-tool',
      tool: 'pnpm',
      argv: ['install', '--frozen-lockfile'],
      expectsFailure: false,
    })

    const corpus = await loadRecentTaskCorpus({ store })

    const entry = corpus.entries[0]
    expect(entry.toolErrorCount).toBe(1)
    expect(entry.topErrorTool).toBe('pnpm install')
  })

  it('counts all non-expectsFailure tool errors and identifies top offender', async () => {
    const store = await makeStore()
    await insertTask(store, { id: 'task-multi-err', status: 'failed' })
    // pnpm appears twice → top offender
    await insertToolInvokedError(store, {
      id: 'te-1',
      taskId: 'task-multi-err',
      tool: 'pnpm',
      argv: ['install'],
    })
    await insertToolInvokedError(store, {
      id: 'te-2',
      taskId: 'task-multi-err',
      tool: 'pnpm',
      argv: ['install'],
    })
    await insertToolInvokedError(store, {
      id: 'te-3',
      taskId: 'task-multi-err',
      tool: 'git',
      argv: ['push'],
    })

    const corpus = await loadRecentTaskCorpus({ store })

    const entry = corpus.entries[0]
    expect(entry.toolErrorCount).toBe(3)
    expect(entry.topErrorTool).toBe('pnpm install')
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

  it('groups arc siblings (origin + recovery) adjacent in the corpus', async () => {
    const store = await makeStore()
    // origin task
    await insertTask(store, {
      id: 'task-origin',
      status: 'failed',
      createdAt: '2026-01-01T00:00:00Z',
      originId: 'task-origin',
    })
    // recovery task — shares origin_id with the origin task
    await insertTask(store, {
      id: 'task-recovery',
      status: 'done',
      createdAt: '2026-01-02T00:00:00Z',
      originId: 'task-origin',
      fixForTaskId: 'task-origin',
    })
    // unrelated task, most recent
    await insertTask(store, {
      id: 'task-unrelated',
      status: 'done',
      createdAt: '2026-01-03T00:00:00Z',
    })

    const corpus = await loadRecentTaskCorpus({ store, limit: 10 })

    const ids = corpus.entries.map((e) => e.taskId)
    // origin and recovery must be adjacent (regardless of which comes first
    // in the overall list, they must not be separated by task-unrelated)
    const idxOrigin = ids.indexOf('task-origin')
    const idxRecovery = ids.indexOf('task-recovery')
    expect(Math.abs(idxOrigin - idxRecovery)).toBe(1)
  })
})

// ── chatFeedback field ─────────────────────────────────────────────────────
// These tests verify the contract for the `chatFeedback` field on ReflectCorpus:
// - Always an array (never undefined or null) regardless of chat table presence
// - Empty when MARS_REFLECT_DISABLED=1 (the isReflectDisabled() gate is respected)

describe('loadRecentTaskCorpus — chatFeedback field', () => {
  afterEach(() => {
    delete process.env.MARS_REFLECT_DISABLED
  })

  it('returns chatFeedback as an empty array when chat tables are absent (graceful fallback)', async () => {
    // The test store uses libsql and does not have chat tables.
    // loadChatFeedback() throws, the try/catch catches it, and chatFeedback
    // stays as the initialised [].
    const store = await makeStore()
    await insertTask(store, { id: 'task-cf-1', status: 'done' })

    const corpus = await loadRecentTaskCorpus({ store })

    expect(Array.isArray(corpus.chatFeedback)).toBe(true)
    expect(corpus.chatFeedback).toEqual([])
  })

  it('returns chatFeedback as an empty array even when no tasks exist', async () => {
    // The early-return path (no tasks) must also produce chatFeedback: []
    const store = await makeStore()

    const corpus = await loadRecentTaskCorpus({ store })

    expect(corpus.entries).toHaveLength(0)
    expect(Array.isArray(corpus.chatFeedback)).toBe(true)
    expect(corpus.chatFeedback).toEqual([])
  })

  it('returns chatFeedback as an empty array when MARS_REFLECT_DISABLED=1', async () => {
    // When reflection is disabled, the chatFeedback loading block is skipped
    // entirely — the corpus still surfaces chatFeedback: [] so callers do not
    // need to guard against undefined.
    const store = await makeStore()
    await insertTask(store, { id: 'task-cf-2', status: 'done' })
    process.env.MARS_REFLECT_DISABLED = '1'

    const corpus = await loadRecentTaskCorpus({ store })

    expect(Array.isArray(corpus.chatFeedback)).toBe(true)
    expect(corpus.chatFeedback).toEqual([])
    // chatSystemPrompt is absent because no feedback was loaded
    expect(corpus.chatSystemPrompt).toBeUndefined()
  })
})
