/**
 * Transactional-emit tests for `upsertTranscript` (queue.ts).
 *
 * `upsertTranscript`'s verifyOutput branch used to write its `step_ended`
 * trace row via a hand-rolled `INSERT INTO trace_events`, independent of the
 * `task_durable_transcripts` upsert alongside it. Slice 4 (modular-core
 * program) replaced that raw INSERT with the sanctioned `emitEvent` write
 * path and put both writes — the transcript "queue state" row and its
 * `step_ended` event — inside one transaction, on both the direct-client
 * path and the `TaskStore.atomic` (store) path.
 *
 * Acceptance criteria exercised here:
 *   (a) no raw INSERT into an events table remains — proven indirectly by
 *       (b)/(c): the event row only ever appears alongside a successful
 *       state write, which is exactly what emitEvent(..., { tx }) guarantees.
 *   (b) the two writes commit together (positive path).
 *   (c)/(d) a rolled-back queue mutation (the state write fails) leaves no
 *       event row behind, on both the direct-client and the store path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../queue').resolveQueueClient
  enqueueTask: typeof import('../queue').enqueueTask
  upsertTranscript: typeof import('../queue').upsertTranscript
}

interface StoreMod {
  createTaskStore: typeof import('../store/task-store').createTaskStore
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-emit-tx-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<{ q: QueueMod; store: StoreMod }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../queue')) as unknown as QueueMod
  const store = (await import('../store/task-store')) as unknown as StoreMod
  await q.migrateQueueSchema()
  return { q, store }
}

const stepEndedRows = async (
  q: QueueMod,
  taskId: string,
): Promise<Array<Record<string, unknown>>> => {
  const result = await q.resolveQueueClient().execute({
    sql: `SELECT id, task_id, payload FROM trace_events WHERE kind = 'step_ended' AND task_id = ?`,
    args: [taskId],
  })
  return result.rows
}

const transcriptRow = async (
  q: QueueMod,
  taskId: string,
): Promise<Record<string, unknown> | undefined> => {
  const result = await q.resolveQueueClient().execute({
    sql: `SELECT task_id FROM task_durable_transcripts WHERE task_id = ?`,
    args: [taskId],
  })
  return result.rows[0]
}

describe('upsertTranscript transactional emit', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('(b) writes the transcript row and its step_ended event in one commit', async () => {
    const { q } = await loadModules(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    await q.upsertTranscript({
      taskId: task.id,
      conversationJson: '[]',
      verifyOutput: 'verify output text',
    })

    expect(await transcriptRow(q, task.id)).toBeDefined()
    const events = await stepEndedRows(q, task.id)
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0].payload as string)).toMatchObject({
      verifyOutput: 'verify output text',
    })
  })

  it('(c) leaves no step_ended row when the state write fails (direct-client path)', async () => {
    const { q } = await loadModules(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })

    // Force the transcript ("queue state") write to fail so the shared
    // transaction has something to roll back.
    await q.resolveQueueClient().execute('DROP TABLE task_durable_transcripts')

    await expect(
      q.upsertTranscript({
        taskId: task.id,
        conversationJson: '[]',
        verifyOutput: 'doomed verify output',
      }),
    ).rejects.toThrow()

    // The transaction must have rolled back the event insert too — no
    // trace_events row was ever committed for this call.
    const result = await q.resolveQueueClient().execute({
      sql: `SELECT id FROM trace_events WHERE kind = 'step_ended' AND task_id = ?`,
      args: [task.id],
    })
    expect(result.rows).toHaveLength(0)
  })

  it('(d) leaves no step_ended row when the state write fails (store/atomic path)', async () => {
    const { q, store } = await loadModules(repo)
    const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
    const taskStore = store.createTaskStore(q.resolveQueueClient())

    await q.resolveQueueClient().execute('DROP TABLE task_durable_transcripts')

    await expect(
      q.upsertTranscript(
        {
          taskId: task.id,
          conversationJson: '[]',
          verifyOutput: 'doomed verify output via store',
        },
        taskStore,
      ),
    ).rejects.toThrow()

    const events = await stepEndedRows(q, task.id)
    expect(events).toHaveLength(0)
  })
})
