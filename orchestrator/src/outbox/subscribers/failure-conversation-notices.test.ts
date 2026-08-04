import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbClient } from '../../core/lib/db.js'

const setupRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), 'mars-failure-conversation-notices-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(join(repo, '.mars'), { recursive: true })
  return repo
}

const makeClient = async (repo: string): Promise<DbClient> => {
  const { openDb } = await import('../../core/lib/db.js')
  const { ensureSchema } = await import('../../core/lib/pg-schema.js')
  const client = openDb(resolve(repo, '.mars'))
  await ensureSchema(client)
  return client
}

const publishBlocked = async (
  client: DbClient,
  taskId: string,
  failureSignature = 'verify:has-diff/no-commits-ahead',
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)`,
    args: ['task.blocked', JSON.stringify({ taskId, fixTaskId: null, failureSignature, failingStep: 'verify' }), Date.now()],
  })
}

describe('failure conversation notices', () => {
  let repo: string
  let client: DbClient
  let chat: typeof import('../../core/lib/chat-store.js')
  let notices: typeof import('./failure-conversation-notices.js')

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
    client = await makeClient(repo)
    chat = await import('../../core/lib/chat-store.js')
    notices = await import('./failure-conversation-notices.js')
    await chat.initChatStore()
    await chat.createThread('Current work')
    await notices.ensureFailureConversationNoticeSubscriber(client)
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('coalesces matching blocked tasks into one urgent immutable Notice', async () => {
    await publishBlocked(client, 'task-one')
    await publishBlocked(client, 'task-two')

    await notices.drainFailureConversationNotices(client, () => Date.now())
    await notices.flushFailureConversationNotices(client, Date.now() + notices.FAILURE_NOTICE_COALESCE_MS)

    // No run is active, so the Notice lands on the main thread rather than
    // hijacking the idle Subject created in beforeEach.
    expect((await chat.listThreads())[0]?.title).toBe('Current work')
    const detail = await chat.getThread(chat.MAIN_THREAD_ID)
    expect(detail?.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        kind: 'notice',
        content: expect.stringContaining('2 blocked tasks'),
      }),
    ])
    expect(detail?.messages[0]?.content).toContain('task branch has no commits ahead of integration')
    expect(detail?.messages[0]?.content).toContain('because')

    await publishBlocked(client, 'task-three')
    await notices.drainFailureConversationNotices(client, () => Date.now() + notices.FAILURE_NOTICE_COALESCE_MS + 1)
    await notices.flushFailureConversationNotices(client, Date.now() + notices.FAILURE_NOTICE_COALESCE_MS * 2 + 1)

    expect((await chat.getThread(chat.MAIN_THREAD_ID))?.messages).toHaveLength(2)
  })

  it('keeps different failure signatures in separate batches and ignores replay', async () => {
    await publishBlocked(client, 'task-one')
    await publishBlocked(client, 'task-two', 'merge:preflight/uncommitted-changes')

    await notices.drainFailureConversationNotices(client, () => Date.now())
    await notices.drainFailureConversationNotices(client, () => Date.now())
    await notices.flushFailureConversationNotices(client, Date.now() + notices.FAILURE_NOTICE_COALESCE_MS)

    const messages = (await chat.getThread(chat.MAIN_THREAD_ID))?.messages ?? []
    expect(messages).toHaveLength(2)
    expect(messages.map((message) => message.content).join('\n')).toContain('integration branch has uncommitted changes')

    const batches = await client.execute(
      `SELECT cause_key, event_count, flushed_at FROM conversation_notice_batches ORDER BY cause_key`,
    )
    expect(batches.rows).toHaveLength(2)
    expect(batches.rows.map((row) => Number((row as { event_count: number }).event_count))).toEqual([1, 1])
    expect(batches.rows.every((row) => (row as { flushed_at: number | null }).flushed_at !== null)).toBe(true)
  })
})
