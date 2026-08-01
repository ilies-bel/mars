/**
 * Equal failure signatures stay one operator-facing Notice and one chat entry.
 * The test uses the public Bell and chat projections so the storage strategy
 * can change without weakening the behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface NoticeStoreModule {
  initNoticeStore: typeof import('../notice-store').initNoticeStore
  createNotice: typeof import('../notice-store').createNotice
  listOpenNotices: typeof import('../notice-store').listOpenNotices
}

interface ChatStoreModule {
  createThread: typeof import('../chat-store').createThread
  listVisibleChatMessages: typeof import('../chat-store').listVisibleChatMessages
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-notice-coalesce-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadStores = async (
  repo: string,
): Promise<{ notices: NoticeStoreModule; chat: ChatStoreModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const notices = (await import('../notice-store')) as unknown as NoticeStoreModule
  const chat = (await import('../chat-store')) as unknown as ChatStoreModule
  await notices.initNoticeStore()
  return { notices, chat }
}

describe('notice-store failure coalescing', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('shows three equal failures as one counted Notice and one updated chat message', async () => {
    const { notices, chat } = await loadStores(repo)
    const thread = await chat.createThread('current session')
    const payload = { signature: 'verify:test/unclassified' }

    const first = await notices.createNotice('signature-storm', payload, 'monitor')
    const firstMessage = await chat.listVisibleChatMessages(thread.id)
    const third = await notices.createNotice('signature-storm', payload, 'monitor')
    await notices.createNotice('signature-storm', payload, 'monitor')

    const open = await notices.listOpenNotices()
    const messages = await chat.listVisibleChatMessages(thread.id)

    expect(third.id).toBe(first.id)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      id: first.id,
      count: 3,
      body: '3 tasks failed with signature verify:test/unclassified.',
    })
    expect(open[0].preloadedResponses).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Show all' })]),
    )
    expect(firstMessage).toHaveLength(1)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: firstMessage[0].id,
      content: '3 tasks failed with signature verify:test/unclassified.',
    })
  })
})
