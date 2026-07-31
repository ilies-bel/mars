import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface ChatStoreModule {
  initChatStore: typeof import('../chat-store').initChatStore
  createThread: typeof import('../chat-store').createThread
  appendMessage: typeof import('../chat-store').appendMessage
  listConversationEntries: typeof import('../chat-store').listConversationEntries
  resolveAlertThread: typeof import('../chat-store').resolveAlertThread
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-chat-conversation-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<ChatStoreModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('../chat-store')) as unknown as ChatStoreModule
}

describe('listConversationEntries', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns every Subject message in global persistence order with its subject context', async () => {
    const chat = await loadModule(repo)
    await chat.initChatStore()
    const first = await chat.createThread('First subject')
    const second = await chat.createThread('Second subject')
    const firstMessage = await chat.appendMessage(first.id, 'user', 'first persisted text')
    const secondMessage = await chat.appendMessage(
      second.id,
      'assistant',
      'second persisted text',
      undefined,
      { kind: 'validation', backingEntityId: 'task-42' },
    )
    await chat.resolveAlertThread(second.id)

    expect(await chat.listConversationEntries()).toEqual([
      expect.objectContaining({
        id: firstMessage.id,
        threadId: first.id,
        subjectId: first.id,
        subjectTitle: 'First subject',
        subjectClosed: false,
        role: 'user',
        content: 'first persisted text',
        segments: [],
        kind: 'acknowledgment',
        backingEntityId: null,
      }),
      expect.objectContaining({
        id: secondMessage.id,
        threadId: second.id,
        subjectId: second.id,
        subjectTitle: 'Second subject',
        subjectClosed: true,
        role: 'assistant',
        content: 'second persisted text',
        segments: [],
        kind: 'validation',
        backingEntityId: 'task-42',
      }),
    ])
  })
})
