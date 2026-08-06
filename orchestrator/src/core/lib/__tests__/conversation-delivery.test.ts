import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const MAIN_THREAD_ID = 'main'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-conversation-delivery-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadStores = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const chat = await import('../chat-store')
  const delivery = await import('../conversation-delivery')
  const { resolveStateClient } = await import('../../store/state-client')
  await chat.initChatStore()
  return { chat, delivery, db: resolveStateClient() }
}

/** Every persisted message in the one conversation, oldest first. */
const conversationFeed = async (
  chat: typeof import('../chat-store'),
): Promise<Array<{ content: string; subthreadId: string; kind: string }>> =>
  (await chat.listConversationEntries()).map((entry) => ({
    content: entry.content,
    subthreadId: entry.subjectId,
    kind: entry.kind,
  }))

describe('conversation notice delivery', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('delivers an urgent Notice to the main thread without spending a provider turn', async () => {
    const { chat, delivery } = await loadStores(repo)

    await delivery.postConversationNotice({
      body: 'A worker needs attention.',
      priority: 'urgent',
      hasActiveRuns: () => true,
    })

    const detail = await chat.getThread(MAIN_THREAD_ID)
    expect(detail?.messages).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: 'A worker needs attention.',
        kind: 'notice',
        context_scope: 'main',
      }),
    ])
    expect(chat.toMessageApiView(detail!.messages[0]!).turnTokens).toBe(0)
  })

  it('delivers to the Subject a run is active on so a Notice reaches the operator mid-grill', async () => {
    const { chat, delivery } = await loadStores(repo)
    const subthread = await chat.createThread('Grilling subthread')
    await chat.setThreadStatus(subthread.id, 'running')

    await delivery.postConversationNotice({
      body: 'I paused the framework while I sort out a failing test on main.',
      priority: 'urgent',
    })

    expect(await conversationFeed(chat)).toEqual([
      expect.objectContaining({
        content: 'I paused the framework while I sort out a failing test on main.',
        subthreadId: subthread.id,
        kind: 'notice',
      }),
    ])
    expect((await chat.getThread(MAIN_THREAD_ID))?.messages).toEqual([])
  })

  it('never lets the sentinel win the most-recently-touched lookup', async () => {
    const { chat, delivery } = await loadStores(repo)
    // An idle Subject, touched after the sentinel was seeded. No run is active,
    // so the Notice belongs on the main thread rather than on this Subject.
    const idle = await chat.createThread('Idle subthread')
    await chat.appendMessage(idle.id, 'user', 'still thinking')

    await delivery.postConversationNotice({
      body: 'Nothing on my side.',
      priority: 'urgent',
    })

    expect(await conversationFeed(chat)).toEqual([
      expect.objectContaining({ subthreadId: idle.id, content: 'still thinking' }),
      expect.objectContaining({ subthreadId: MAIN_THREAD_ID, content: 'Nothing on my side.' }),
    ])
  })

  it('preserves ordered preloaded responses on the delivered Notice', async () => {
    const { chat, delivery } = await loadStores(repo)

    await delivery.postConversationNotice({
      body: 'A worker needs attention.',
      priority: 'urgent',
      segments: [
        { type: 'text', text: 'A worker needs attention.' },
        {
          type: 'preloaded_responses',
          responses: [
            { id: 'restart', label: 'Restart', target: { type: 'verb', op: 'restart', entityId: 'task-1' } },
            { id: 'review', label: 'Review', target: { type: 'subthread', title: 'Review task-1' } },
          ],
        },
      ],
      backingEntityId: 'task-1',
      hasActiveRuns: () => false,
    })

    const detail = await chat.getThread(MAIN_THREAD_ID)
    expect(detail?.messages[0]?.segments).toEqual([
      { type: 'text', text: 'A worker needs attention.' },
      expect.objectContaining({
        type: 'preloaded_responses',
        responses: [
          expect.objectContaining({ id: 'restart', label: 'Restart' }),
          expect.objectContaining({ id: 'review', label: 'Review' }),
        ],
      }),
    ])
  })

  it('carries an autonomous Notice’s Offer set through instead of flattening it to text', async () => {
    const { chat, delivery } = await loadStores(repo)

    await delivery.postConversationNotice({
      kind: 'steward.worker-reduced',
      payload: { from: 12, to: 3, pagingPps: 900 },
      priority: 'urgent',
      segments: [
        { type: 'text', text: 'I reduced implement workers from 12 to 3.' },
        {
          type: 'preloaded_responses',
          responses: [
            { id: 'noted', label: 'Noted', target: { type: 'verb', op: 'ack' } },
            {
              id: 'stop',
              label: 'Stop doing this automatically',
              target: { type: 'lever', name: 'steward.worker-tuning', level: 'off' },
            },
          ],
        },
      ],
    })

    const detail = await chat.getThread(MAIN_THREAD_ID)
    // The body still comes from the copy registry; only the segments are the
    // caller's.
    expect(detail?.messages[0]?.content).toContain('I reduced implement workers from 12 to 3')
    expect(detail?.messages[0]?.segments).toEqual([
      { type: 'text', text: 'I reduced implement workers from 12 to 3.' },
      expect.objectContaining({
        type: 'preloaded_responses',
        responses: [
          expect.objectContaining({ id: 'noted' }),
          expect.objectContaining({
            id: 'stop',
            target: { type: 'lever', name: 'steward.worker-tuning', level: 'off' },
          }),
        ],
      }),
    ])
  })

  it('holds routine Notices until the active run reaches a natural pause', async () => {
    const { chat, delivery } = await loadStores(repo)

    await delivery.postConversationNotice({
      body: 'Routine status update.',
      priority: 'routine',
      hasActiveRuns: () => true,
    })
    expect(await conversationFeed(chat)).toEqual([])

    await delivery.flushRoutineConversationNotices(() => false)

    expect(await conversationFeed(chat)).toEqual([
      expect.objectContaining({
        content: 'Routine status update.',
        subthreadId: MAIN_THREAD_ID,
        kind: 'notice',
      }),
    ])
  })

  it('delivers routine Notices immediately when no run is active', async () => {
    const { chat, delivery } = await loadStores(repo)

    await delivery.postConversationNotice({
      body: 'The queue is clear.',
      priority: 'routine',
      hasActiveRuns: () => false,
    })

    expect(await conversationFeed(chat)).toEqual([
      expect.objectContaining({ content: 'The queue is clear.', kind: 'notice' }),
    ])
  })

  it('delivers an autonomous Notice to the main thread without creating a Subject', async () => {
    const { chat, delivery } = await loadStores(repo)

    const result = await delivery.postConversationNotice({
      kind: 'steward.worker-restored',
      payload: { from: 1, to: 2 },
      priority: 'routine',
      hasActiveRuns: () => false,
    })

    expect(result.delivered).toBe(true)
    expect(await chat.listThreads()).toEqual([])
    expect(await conversationFeed(chat)).toEqual([
      expect.objectContaining({ subthreadId: MAIN_THREAD_ID, kind: 'notice' }),
    ])
  })

  it('flushes a waiting routine Notice when its Subthread closes', async () => {
    const { chat, delivery } = await loadStores(repo)
    const subthread = await chat.createThread('Closing subthread')

    await delivery.postConversationNotice({
      body: 'Saved for the next pause.',
      priority: 'routine',
      hasActiveRuns: () => true,
    })
    await chat.closeSubject(subthread.id)

    expect((await chat.getThread(subthread.id))?.thread.closed_at).not.toBeNull()
    expect(await conversationFeed(chat)).toEqual([
      expect.objectContaining({ content: 'Saved for the next pause.', kind: 'notice' }),
    ])
  })

  it('retries an undelivered urgent Notice even while a run is active', async () => {
    const { chat, delivery, db } = await loadStores(repo)
    // The shape an interrupted (or pre-sentinel) delivery leaves behind: an
    // urgent row that was never marked delivered.
    await db.execute({
      sql: `INSERT INTO conversation_pending_messages (id, body, segments, backing_entity_id, priority, created_at)
            VALUES (?, ?, ?, NULL, 'urgent', ?)`,
      args: ['stranded', 'I stopped dispatch: the provider rejected on spend.', null, 1],
    })
    await delivery.postConversationNotice({
      body: 'Routine status update.',
      priority: 'routine',
      hasActiveRuns: () => true,
    })

    const delivered = await delivery.flushRoutineConversationNotices(() => true)

    expect(delivered).toBe(1)
    expect(await conversationFeed(chat)).toEqual([
      expect.objectContaining({ content: 'I stopped dispatch: the provider rejected on spend.' }),
    ])

    // ...and it is not delivered twice once the run ends.
    await delivery.flushRoutineConversationNotices(() => false)
    expect(await conversationFeed(chat)).toEqual([
      expect.objectContaining({ content: 'I stopped dispatch: the provider rejected on spend.' }),
      expect.objectContaining({ content: 'Routine status update.' }),
    ])
  })

  it('broadcasts a chat invalidation once per delivered Notice', async () => {
    const { delivery } = await loadStores(repo)
    const broadcast = vi.fn()
    const viewStreamHub = { broadcast }

    await delivery.postConversationNotice({
      body: 'Delivered right away.',
      priority: 'urgent',
      viewStreamHub,
    })
    expect(broadcast.mock.calls).toEqual([['chat']])

    await delivery.postConversationNotice({
      body: 'Held for the pause.',
      priority: 'routine',
      hasActiveRuns: () => true,
      viewStreamHub,
    })
    expect(broadcast.mock.calls).toEqual([['chat']])

    await delivery.flushRoutineConversationNotices(() => false, viewStreamHub)
    expect(broadcast.mock.calls).toEqual([['chat'], ['chat']])
  })
})
