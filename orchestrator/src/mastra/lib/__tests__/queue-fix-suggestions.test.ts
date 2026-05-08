import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
}

interface FixModule {
  upsertFixSuggestion: typeof import('../../queue-fix-suggestions').upsertFixSuggestion
  handleTaskFailure: typeof import('../../queue-fix-suggestions').handleTaskFailure
  markTaskDropped: typeof import('../../queue-fix-suggestions').markTaskDropped
  getRetryBudget: typeof import('../../queue-fix-suggestions').getRetryBudget
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-fix-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; fix: FixModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  delete process.env.MARS_FIX_RETRY_BUDGET
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const fix = (await import(
    '../../queue-fix-suggestions'
  )) as unknown as FixModule
  return { q, fix }
}

describe('queue-fix-suggestions', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('upsertFixSuggestion is idempotent for the same signature', async () => {
    const { q, fix } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const first = await fix.upsertFixSuggestion({
      sourceTaskId: t.id,
      failureSignature: 'abc1234567890123',
      failingStep: 'verify:typecheck',
      truncatedError: 'TS2304: Cannot find name foo',
      branch: 'task/x',
    })
    expect(first.created).toBe(true)
    const second = await fix.upsertFixSuggestion({
      sourceTaskId: t.id,
      failureSignature: 'abc1234567890123',
      failingStep: 'verify:typecheck',
      truncatedError: 'TS2304: Cannot find name foo',
      branch: 'task/x',
    })
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)
  })

  it('different signatures produce distinct suggestions', async () => {
    const { q, fix } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const a = await fix.upsertFixSuggestion({
      sourceTaskId: t.id,
      failureSignature: 'aaaaaaaaaaaaaaaa',
      failingStep: 'verify:typecheck',
      truncatedError: 'errA',
      branch: null,
    })
    const b = await fix.upsertFixSuggestion({
      sourceTaskId: t.id,
      failureSignature: 'bbbbbbbbbbbbbbbb',
      failingStep: 'verify:test',
      truncatedError: 'errB',
      branch: null,
    })
    expect(a.id).not.toBe(b.id)
    expect(a.created).toBe(true)
    expect(b.created).toBe(true)
  })

  it('handleTaskFailure transitions task to blocked with blocker_id and increments retry_count', async () => {
    const { q, fix } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const result = await fix.handleTaskFailure({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
      branch: 'task/x',
    })
    expect(result.outcome).toBe('blocked')
    expect(result.suggestionId).toBeDefined()
    expect(result.retryCount).toBe(1)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('blocked')
    expect(reloaded?.blockerId).toBe(result.suggestionId)
    expect(reloaded?.retryCount).toBe(1)
  })

  it('handleTaskFailure transitions to dropped (not blocked) when retry budget exhausted', async () => {
    const { q, fix } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    // First failure: retry_count 0 -> 1, blocked.
    await fix.handleTaskFailure({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'errA',
    })
    // Second failure with default budget=1, retry_count is now 1 >= 1: drop.
    const result = await fix.handleTaskFailure({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'errB',
    })
    expect(result.outcome).toBe('dropped')

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('dropped')
    expect(reloaded?.dropReason).toMatch(/^retry_budget_exhausted:/)
  })

  it('respects MARS_FIX_RETRY_BUDGET env var', async () => {
    process.env.MARS_FIX_RETRY_BUDGET = '0'
    const { q, fix } = await loadModules(repo)
    process.env.MARS_FIX_RETRY_BUDGET = '0'
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    // With budget=0, even the first failure drops the task.
    const result = await fix.handleTaskFailure({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'errA',
    })
    expect(result.outcome).toBe('dropped')
    expect(fix.getRetryBudget()).toBe(0)
  })

  it('handleTaskFailure is a no-op for unknown task id', async () => {
    const { fix } = await loadModules(repo)
    const result = await fix.handleTaskFailure({
      taskId: 'no-such-task',
      failingStep: 'verify',
      errorOutput: 'err',
    })
    expect(result.outcome).toBe('noop')
  })

  it('repeat failure with the same signature reuses the suggestion (no double-block)', async () => {
    const { q, fix } = await loadModules(repo)
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const a = await fix.handleTaskFailure({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    const b = await fix.handleTaskFailure({
      taskId: t.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: cannot find name foo',
    })
    expect(a.suggestionId).toBe(b.suggestionId)

    // Verify only one suggestion row exists.
    const r = await q.getClient().execute({
      sql: `SELECT COUNT(*) as n FROM task_suggestions WHERE source_task_id = ? AND kind = 'fix'`,
      args: [t.id],
    })
    const count = (r.rows[0] as unknown as { n: number }).n
    expect(Number(count)).toBe(1)
  })
})
