import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  upsertTranscript: typeof import('../../queue').upsertTranscript
  capConversationJson: typeof import('../../queue').capConversationJson
}

interface DeepQueryModule {
  loadDeepReflectArc: typeof import('../deep-reflect-query').loadDeepReflectArc
  listDeepReflectArcCandidates: typeof import('../deep-reflect-query').listDeepReflectArcCandidates
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
  await q.migrateQueueSchema()
  const dq = (await import('../deep-reflect-query')) as unknown as DeepQueryModule
  return { q, dq }
}

describe('listDeepReflectArcCandidates', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns empty array when DB is empty', async () => {
    const { dq } = await loadModules(repo)
    const result = await dq.listDeepReflectArcCandidates({
      withTranscriptOnly: false,
    })
    expect(result).toEqual([])
  })

  it('withTranscriptOnly: false returns arcs without transcripts', async () => {
    const { q, dq } = await loadModules(repo)
    // Task with no transcript
    const noTranscript = await q.enqueueTask('no transcript task', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = ? WHERE id = ?`,
      args: ['done', noTranscript.id],
    })

    // withTranscriptOnly: true (default) should exclude it
    const withOnly = await dq.listDeepReflectArcCandidates({
      withTranscriptOnly: true,
    })
    expect(withOnly.find((a) => a.originId === noTranscript.id)).toBeUndefined()

    // withTranscriptOnly: false should include it
    const withAll = await dq.listDeepReflectArcCandidates({
      withTranscriptOnly: false,
    })
    const found = withAll.find((a) => a.originId === noTranscript.id)
    expect(found).toBeDefined()
    expect(found?.taskCount).toBe(1)
    expect(found?.statusMix.done).toBe(1)
  })

  it('withTranscriptOnly: false includes ad-hoc single-task arcs alongside transcript arcs', async () => {
    const { q, dq } = await loadModules(repo)

    // Arc with transcript
    const withTx = await q.enqueueTask('task with transcript', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = ? WHERE id = ?`,
      args: ['done', withTx.id],
    })
    await q.upsertTranscript({ taskId: withTx.id, conversationJson: '[]' })

    // Arc without transcript (ad-hoc)
    const noTx = await q.enqueueTask('ad-hoc task no transcript', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = ? WHERE id = ?`,
      args: ['done', noTx.id],
    })

    const all = await dq.listDeepReflectArcCandidates({
      limit: 100,
      withTranscriptOnly: false,
    })
    const ids = all.map((a) => a.originId)
    expect(ids).toContain(withTx.id)
    expect(ids).toContain(noTx.id)
  })

  it('limit is respected', async () => {
    const { q, dq } = await loadModules(repo)
    for (let i = 0; i < 5; i++) {
      const t = await q.enqueueTask(`task ${i}`, undefined, { skipTriage: true })
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = ? WHERE id = ?`,
        args: ['done', t.id],
      })
    }
    const result = await dq.listDeepReflectArcCandidates({
      limit: 3,
      withTranscriptOnly: false,
    })
    expect(result.length).toBeLessThanOrEqual(3)
  })
})

describe('loadDeepReflectArc — durable transcript read path', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns durable transcript events from trace_events when no JSONL file exists on disk (test (b))', async () => {
    // This test verifies Half 2: loadDeepReflectArc prefers the trace_events
    // transcript over the filesystem fallback when the durable row is present.
    const { q, dq } = await loadModules(repo)

    // Create a task. By default it has no claude_session_ids, so the
    // filesystem fallback (readAllTranscriptsForTask) returns empty.
    const task = await q.enqueueTask('durable transcript test', undefined, {
      skipTriage: true,
    })

    // Insert a trace_events row the way the transcript-append subscriber would,
    // carrying the conversation transcript in the payload.
    const events = [
      { type: 'assistant', content: 'durable reply from trace_events' },
    ]
    await q.resolveQueueClient().execute({
      sql: `INSERT INTO trace_events (id, timestamp, kind, severity, task_id, phase, payload)
            VALUES (?, ?, 'step_ended', 'info', ?, 'code', ?)`,
      args: [
        `transcript-append-${task.id}-0`,
        new Date().toISOString(),
        task.id,
        JSON.stringify({
          stepName: 'code',
          workflowInstanceId: `transcript-append-${task.id}`,
          outcome: 'success',
          durationMs: 0,
          transcript: JSON.stringify(events),
        }),
      ],
    })

    const arc = await dq.loadDeepReflectArc(task.id)
    expect(arc).not.toBeNull()
    const taskEntry = arc!.tasks[0]
    expect(taskEntry.conversation).toHaveLength(1)
    expect(taskEntry.conversation[0].type).toBe('assistant')
    expect(taskEntry.hasTranscript).toBe(true)
    expect(taskEntry.transcriptNotes).toHaveLength(0)
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
