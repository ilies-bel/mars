import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

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
  await chat.initChatStore()
  return { chat, delivery }
}

describe('conversation notice delivery', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('delivers an urgent Notice immediately without spending a provider turn', async () => {
    const { chat, delivery } = await loadStores(repo)
    const subthread = await chat.createThread('Current subthread')

    await delivery.postConversationNotice({
      body: 'A worker needs attention.',
      priority: 'urgent',
      hasActiveRuns: () => true,
    })

    const detail = await chat.getThread(subthread.id)
    expect(detail?.thread.status).toBe('idle')
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

  it('preserves ordered preloaded responses on the delivered Notice', async () => {
    const { chat, delivery } = await loadStores(repo)
    const subthread = await chat.createThread('Current subthread')

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

    const detail = await chat.getThread(subthread.id)
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

  it('holds routine Notices until the active run reaches a natural pause', async () => {
    const { chat, delivery } = await loadStores(repo)
    const subthread = await chat.createThread('Current subthread')

    await delivery.postConversationNotice({
      body: 'Routine status update.',
      priority: 'routine',
      hasActiveRuns: () => true,
    })
    expect((await chat.getThread(subthread.id))?.messages).toEqual([])

    await delivery.flushRoutineConversationNotices(() => false)

    expect((await chat.getThread(subthread.id))?.messages).toEqual([
      expect.objectContaining({ content: 'Routine status update.', kind: 'notice', context_scope: 'main' }),
    ])
  })

  it('delivers routine Notices immediately when no run is active', async () => {
    const { chat, delivery } = await loadStores(repo)
    const subthread = await chat.createThread('Current subthread')

    await delivery.postConversationNotice({
      body: 'The queue is clear.',
      priority: 'routine',
      hasActiveRuns: () => false,
    })

    expect((await chat.getThread(subthread.id))?.messages).toEqual([
      expect.objectContaining({ content: 'The queue is clear.', kind: 'notice', context_scope: 'main' }),
    ])
  })

  it('keeps an autonomous Notice pending instead of creating a Subthread', async () => {
    const { chat, delivery } = await loadStores(repo)

    const result = await delivery.postConversationNotice({
      kind: 'steward.worker-restored',
      payload: { from: 1, to: 2 },
      priority: 'routine',
      hasActiveRuns: () => false,
    })

    expect(result.delivered).toBe(false)
    expect(await chat.listThreads()).toEqual([])
  })

  it('flushes a waiting routine Notice when its Subthread closes', async () => {
    const { chat, delivery } = await loadStores(repo)
    const subthread = await chat.createThread('Closing subthread')

    await delivery.postConversationNotice({
      body: 'Saved for the next pause.',
      priority: 'routine',
      hasActiveRuns: () => true,
    })
    await chat.closeSubthread(subthread.id)

    const detail = await chat.getThread(subthread.id)
    expect(detail?.thread.closed_at).not.toBeNull()
    expect(detail?.messages).toEqual([
      expect.objectContaining({ content: 'Saved for the next pause.', kind: 'notice', context_scope: 'main' }),
    ])
  })
})
