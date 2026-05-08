import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
  upsertTranscript: typeof import('../../queue').upsertTranscript
  capConversationJson: typeof import('../../queue').capConversationJson
}

interface DeepQueryModule {
  pickDeepReflectCandidate: typeof import('../deep-reflect-query').pickDeepReflectCandidate
  loadDeepReflectSession: typeof import('../deep-reflect-query').loadDeepReflectSession
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-deep-reflect-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; dq: DeepQueryModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const dq = (await import('../deep-reflect-query')) as unknown as DeepQueryModule
  return { q, dq }
}

const recordCost = async (
  q: QueueModule,
  taskId: string,
  costUsd: number,
): Promise<void> => {
  const now = new Date().toISOString()
  await q.getClient().execute({
    sql: `INSERT INTO task_signals
            (task_id, step_id, input_tokens, output_tokens,
             cache_create_tokens, cache_read_tokens, total_cost_usd,
             message_count, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [taskId, 'run-claude-code', 0, 0, 0, 0, costUsd, 0, now],
  })
}

const setStatus = async (
  q: QueueModule,
  taskId: string,
  status: string,
  createdAt?: string,
): Promise<void> => {
  await q.getClient().execute({
    sql: `UPDATE tasks SET status = ?${createdAt ? ', created_at = ?' : ''} WHERE id = ?`,
    args: createdAt ? [status, createdAt, taskId] : [status, taskId],
  })
}

describe('pickDeepReflectCandidate', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns null when DB is empty', async () => {
    const { dq } = await loadModules(repo)
    const r = await dq.pickDeepReflectCandidate()
    expect(r).toBeNull()
  })

  it('returns null when there are tasks but none have transcripts', async () => {
    const { q, dq } = await loadModules(repo)
    const t = await q.enqueueTask('p', undefined, { skipTriage: true })
    await setStatus(q, t.id, 'failed')
    const r = await dq.pickDeepReflectCandidate()
    expect(r).toBeNull()
  })

  it('rule 1: prefers most recent failed task with transcript', async () => {
    const { q, dq } = await loadModules(repo)
    const tFail = await q.enqueueTask('failing task', undefined, { skipTriage: true })
    await setStatus(q, tFail.id, 'failed')
    await q.upsertTranscript({ taskId: tFail.id, conversationJson: '[]' })

    const tDone = await q.enqueueTask('done task', undefined, { skipTriage: true })
    await setStatus(q, tDone.id, 'done')
    await q.upsertTranscript({ taskId: tDone.id, conversationJson: '[]' })
    await recordCost(q, tDone.id, 5)

    const r = await dq.pickDeepReflectCandidate()
    expect(r).not.toBeNull()
    expect(r?.taskId).toBe(tFail.id)
    expect(r?.reason.reason).toMatch(/most recent failure/i)
  })

  it('rule 2: picks highest-cost done task within last 7d when ≥ 2× median', async () => {
    const { q, dq } = await loadModules(repo)
    const cheap1 = await q.enqueueTask('cheap1', undefined, { skipTriage: true })
    await setStatus(q, cheap1.id, 'done')
    await q.upsertTranscript({ taskId: cheap1.id, conversationJson: '[]' })
    await recordCost(q, cheap1.id, 0.05)

    const cheap2 = await q.enqueueTask('cheap2', undefined, { skipTriage: true })
    await setStatus(q, cheap2.id, 'done')
    await q.upsertTranscript({ taskId: cheap2.id, conversationJson: '[]' })
    await recordCost(q, cheap2.id, 0.05)

    const expensive = await q.enqueueTask('expensive', undefined, {
      skipTriage: true,
    })
    await setStatus(q, expensive.id, 'done')
    await q.upsertTranscript({ taskId: expensive.id, conversationJson: '[]' })
    await recordCost(q, expensive.id, 1.0)

    const r = await dq.pickDeepReflectCandidate()
    expect(r).not.toBeNull()
    expect(r?.taskId).toBe(expensive.id)
    expect(r?.reason.reason).toMatch(/highest-cost done/i)
  })

  it('rule 3: falls back to most recent done when no expensive outlier', async () => {
    const { q, dq } = await loadModules(repo)
    // All similar cost.
    const a = await q.enqueueTask('a', undefined, { skipTriage: true })
    await setStatus(q, a.id, 'done')
    await q.upsertTranscript({ taskId: a.id, conversationJson: '[]' })
    await recordCost(q, a.id, 0.1)

    const b = await q.enqueueTask('b', undefined, { skipTriage: true })
    await setStatus(q, b.id, 'done')
    await q.upsertTranscript({ taskId: b.id, conversationJson: '[]' })
    await recordCost(q, b.id, 0.1)

    const r = await dq.pickDeepReflectCandidate()
    expect(r).not.toBeNull()
    // Most recent created -> b
    expect(r?.taskId).toBe(b.id)
    expect(r?.reason.reason).toMatch(/most recent done/i)
  })
})

describe('capConversationJson', () => {
  it('passes through small payloads unchanged', async () => {
    const repo = setupRepo()
    try {
      const { q } = await loadModules(repo)
      const small = JSON.stringify([{ a: 1 }])
      expect(q.capConversationJson(small)).toBe(small)
    } finally {
      delete process.env.MARS_REPO
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('drops the middle and inserts a marker for oversized payloads', async () => {
    const repo = setupRepo()
    try {
      const { q } = await loadModules(repo)
      const big = 'x'.repeat(3 * 1024 * 1024)
      const out = q.capConversationJson(big)
      expect(out.length).toBeLessThan(big.length)
      expect(out).toMatch(/"truncated":true/)
      expect(out).toMatch(/"skippedBytes":/)
    } finally {
      delete process.env.MARS_REPO
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
