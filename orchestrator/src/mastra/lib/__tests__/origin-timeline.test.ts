import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
  upsertTranscript: typeof import('../../queue').upsertTranscript
}

interface OriginTimelineModule {
  loadOriginTimeline: typeof import('../origin-timeline').loadOriginTimeline
  pickTopOrigin: typeof import('../origin-timeline').pickTopOrigin
  scoreOriginTimeline: typeof import('../origin-timeline').scoreOriginTimeline
  formatOriginTimeline: typeof import('../origin-timeline').formatOriginTimeline
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-origin-timeline-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; ot: OriginTimelineModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const ot = (await import('../origin-timeline')) as unknown as OriginTimelineModule
  return { q, ot }
}

const setStatus = async (
  q: QueueModule,
  taskId: string,
  status: string,
  updatedAt?: string,
): Promise<void> => {
  await q.getClient().execute({
    sql: `UPDATE tasks SET status = ?${updatedAt ? ', updated_at = ?' : ''} WHERE id = ?`,
    args: updatedAt ? [status, updatedAt, taskId] : [status, taskId],
  })
}

const addFixTask = async (
  q: QueueModule,
  prompt: string,
  originTaskId: string,
  fixForTaskId: string,
): Promise<{ id: string }> => {
  // Insert a fix task manually so we can control origin_id and fix_for_task_id
  const id = `mars-fix-${Math.random().toString(36).slice(2, 10)}`
  const now = new Date().toISOString()
  await q.getClient().execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at, origin_id, fix_for_task_id, kind)
          VALUES (?, ?, 'queued', ?, ?, ?, ?, 'fix')`,
    args: [id, prompt, now, now, originTaskId, fixForTaskId],
  })
  return { id }
}

describe('scoreOriginTimeline', () => {
  it('sums spanCount + retryCount + verifyFailureCount', async () => {
    const repo = setupRepo()
    try {
      const { ot } = await loadModules(repo)
      expect(ot.scoreOriginTimeline({ spanCount: 3, retryCount: 1, verifyFailureCount: 2 })).toBe(6)
      expect(ot.scoreOriginTimeline({ spanCount: 1, retryCount: 0, verifyFailureCount: 0 })).toBe(1)
    } finally {
      delete process.env.MARS_REPO
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('pickTopOrigin', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns null when DB is empty', async () => {
    const { ot } = await loadModules(repo)
    expect(await ot.pickTopOrigin()).toBeNull()
  })

  it('returns null when no tasks are done or failed', async () => {
    const { q, ot } = await loadModules(repo)
    await q.enqueueTask('queued task', undefined, { skipTriage: true })
    expect(await ot.pickTopOrigin()).toBeNull()
  })

  it('picks the origin with the highest score', async () => {
    const { q, ot } = await loadModules(repo)

    // Origin A: just one done task (score=1)
    const a = await q.enqueueTask('origin A', undefined, { skipTriage: true })
    await setStatus(q, a.id, 'done')

    // Origin B: one done task + one fix task (score=2: span=2, retry=1, verify=0 → 3)
    const b = await q.enqueueTask('origin B', undefined, { skipTriage: true })
    await setStatus(q, b.id, 'done')
    const bFix = await addFixTask(q, 'fix for B', b.id, b.id)
    await setStatus(q, bFix.id, 'done')

    const pick = await ot.pickTopOrigin()
    expect(pick).not.toBeNull()
    expect(pick?.originId).toBe(b.id)
    // B: span=2, retry=1, verify=0 → score=3; A: span=1, retry=0, verify=0 → score=1
    expect(pick?.score).toBe(3)
  })

  it('tie-break: when scores are equal, picks the most recently active origin', async () => {
    const { q, ot } = await loadModules(repo)

    // Two origins each with score=1 (span=1, retry=0, verify=0)
    const older = await q.enqueueTask('older origin', undefined, { skipTriage: true })
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`,
      args: ['2025-01-01T10:00:00.000Z', older.id],
    })

    const newer = await q.enqueueTask('newer origin', undefined, { skipTriage: true })
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`,
      args: ['2025-06-01T10:00:00.000Z', newer.id],
    })

    const pick = await ot.pickTopOrigin()
    expect(pick).not.toBeNull()
    // Both have score=1, but 'newer' has a later updated_at
    expect(pick?.originId).toBe(newer.id)
  })

  it('tie-break is stable across multiple calls (deterministic)', async () => {
    const { q, ot } = await loadModules(repo)

    const t1 = await q.enqueueTask('task alpha', undefined, { skipTriage: true })
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`,
      args: ['2025-03-15T08:00:00.000Z', t1.id],
    })

    const t2 = await q.enqueueTask('task beta', undefined, { skipTriage: true })
    await q.getClient().execute({
      sql: `UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`,
      args: ['2025-03-15T12:00:00.000Z', t2.id],
    })

    // Call multiple times — same result every time
    const results = await Promise.all([ot.pickTopOrigin(), ot.pickTopOrigin(), ot.pickTopOrigin()])
    const ids = results.map((r) => r?.originId)
    expect(new Set(ids).size).toBe(1)
    // t2 has later updated_at → should win
    expect(ids[0]).toBe(t2.id)
  })

  it('counts verify_failure_count from non-empty verify_output in transcripts', async () => {
    const { q, ot } = await loadModules(repo)

    // Origin A: one done task with verify output (score = span=1 + retry=0 + verify=1 = 2)
    const a = await q.enqueueTask('origin with verify failure', undefined, { skipTriage: true })
    await setStatus(q, a.id, 'done')
    await q.upsertTranscript({ taskId: a.id, conversationJson: '[]', verifyOutput: 'FAIL: 1 test failed' })

    // Origin B: one done task, no verify output (score = 1)
    const b = await q.enqueueTask('origin without verify failure', undefined, { skipTriage: true })
    await setStatus(q, b.id, 'done')

    const pick = await ot.pickTopOrigin()
    expect(pick).not.toBeNull()
    expect(pick?.originId).toBe(a.id)
    expect(pick?.score).toBe(2)
  })
})

describe('loadOriginTimeline', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns null for an unknown originId', async () => {
    const { ot } = await loadModules(repo)
    expect(await ot.loadOriginTimeline('mars-unknown-id')).toBeNull()
  })

  it('returns timeline with correct counts for an arc with a fix task', async () => {
    const { q, ot } = await loadModules(repo)

    const origin = await q.enqueueTask('the origin task', undefined, { skipTriage: true })
    await setStatus(q, origin.id, 'done')
    await q.upsertTranscript({
      taskId: origin.id,
      conversationJson: '[]',
      verifyOutput: 'Error: test failed',
    })

    const fix = await addFixTask(q, 'fix the origin', origin.id, origin.id)
    await setStatus(q, fix.id, 'done')

    const timeline = await ot.loadOriginTimeline(origin.id)
    expect(timeline).not.toBeNull()
    expect(timeline?.originId).toBe(origin.id)
    expect(timeline?.spanCount).toBe(2)
    expect(timeline?.retryCount).toBe(1)
    expect(timeline?.verifyFailureCount).toBe(1)
    expect(timeline?.tasks).toHaveLength(2)
    expect(timeline?.tasks[0].taskId).toBe(origin.id)
    expect(timeline?.tasks[0].hasVerifyOutput).toBe(true)
    expect(timeline?.tasks[1].kind).toBe('fix')
    expect(timeline?.tasks[1].hasVerifyOutput).toBe(false)
  })
})

describe('formatOriginTimeline', () => {
  it('includes summary header and task rows', async () => {
    const repo = setupRepo()
    try {
      const { ot } = await loadModules(repo)
      const timeline = {
        originId: 'mars-abc123',
        spanCount: 2,
        retryCount: 1,
        verifyFailureCount: 1,
        tasks: [
          {
            taskId: 'mars-abc123',
            status: 'done',
            kind: 'task',
            createdAt: '2025-01-01T00:00:00.000Z',
            error: null,
            promptPreview: 'implement feature X',
            hasVerifyOutput: true,
          },
          {
            taskId: 'mars-fix001',
            status: 'done',
            kind: 'fix',
            createdAt: '2025-01-02T00:00:00.000Z',
            error: 'verify failed',
            promptPreview: 'fix feature X',
            hasVerifyOutput: false,
          },
        ],
      }
      const formatted = ot.formatOriginTimeline(timeline)
      expect(formatted).toMatch(/Origin arc mars-abc123/)
      expect(formatted).toMatch(/2 task\(s\)/)
      expect(formatted).toMatch(/1 retries/)
      expect(formatted).toMatch(/1 verify failure/)
      expect(formatted).toMatch(/mars-abc123/)
      expect(formatted).toMatch(/\[verify-failed\]/)
      expect(formatted).toMatch(/mars-fix001/)
      expect(formatted).toMatch(/kind=fix/)
    } finally {
      delete process.env.MARS_REPO
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
