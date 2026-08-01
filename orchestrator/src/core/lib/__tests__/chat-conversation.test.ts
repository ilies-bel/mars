import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createAppServices } from '../../app-services'
import { nullTraceStore } from '../run-tool'

interface ChatStoreModule {
  initChatStore: typeof import('../chat-store').initChatStore
  createThread: typeof import('../chat-store').createThread
  appendMessage: typeof import('../chat-store').appendMessage
  listConversationEntries: typeof import('../chat-store').listConversationEntries
  startThreadFromAlert: typeof import('../chat-store').startThreadFromAlert
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
        resolution: null,
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
        resolution: 'resolved',
      }),
    ])
  })

  it('keeps every durable message while reporting the current readable-memory cut', async () => {
    const chat = await loadModule(repo)
    await chat.initChatStore()
    const subject = await chat.createThread('Finished subject')
    await chat.appendMessage(subject.id, 'assistant', 'Older, durable narration')
    await chat.appendMessage(subject.id, 'assistant', 'Newer, durable narration')
    const { advanceMainMemoryWindow } = await import('../../daemon/chat-memory-window')
    await advanceMainMemoryWindow(undefined, {
      startsAfterSeq: 1,
      reason: 'capacity',
    }, 1_700_000_000_000)
    const services = createAppServices({
      traceStore: nullTraceStore,
      buildAlertSources: async () => ({
        listFailedArcs: async () => [],
        listStaleWorktrees: async () => [],
      }),
    })

    const conversation = await services.viewChatConversation()

    expect(conversation.entries).toHaveLength(2)
    expect(conversation.entries.map((entry) => entry.content)).toEqual([
      'Older, durable narration',
      'Newer, durable narration',
    ])
    expect(conversation).toMatchObject({
      memoryStartsAfterSeq: 1,
      memoryCutAt: 1_700_000_000_000,
      memoryCutReason: 'capacity',
    })
  })

  it('keeps a validation message in place and marks it resolved when its task completes', async () => {
    const chat = await loadModule(repo)
    await chat.initChatStore()
    const { resolveStateClient } = await import('../../store/state-client')
    const timestamp = new Date().toISOString()
    await resolveStateClient().execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES (?, ?, 'awaiting-human', ?, ?)`,
      args: ['task-awaiting-approval', 'approve this task', timestamp, timestamp],
    })
    const subject = await chat.createThread('Approval needed')
    const message = await chat.appendMessage(
      subject.id,
      'assistant',
      'Please approve the implementation.',
      [{ type: 'text', text: 'Please approve the implementation.' }],
      { kind: 'validation', backingEntityId: 'task-awaiting-approval' },
    )

    expect(await chat.listConversationEntries()).toEqual([
      expect.objectContaining({ id: message.id, resolution: null }),
    ])

    await resolveStateClient().execute({
      sql: `UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), 'task-awaiting-approval'],
    })

    expect(await chat.listConversationEntries()).toEqual([
      expect.objectContaining({
        id: message.id,
        content: 'Please approve the implementation.',
        segments: [{ type: 'text', text: 'Please approve the implementation.' }],
        resolution: 'resolved',
      }),
    ])
  })

  it('keeps an alert-origin message in place and marks it resolved when its alert resolves', async () => {
    const chat = await loadModule(repo)
    await chat.initChatStore()
    const alert = await chat.startThreadFromAlert('arc-42', 'A task needs attention', {
      type: 'alert',
      kind: 'failed',
      entityId: 'task-42',
      priority: 'high',
      title: 'A task needs attention',
      whyNow: 'its verify step failed',
      actions: [],
      resolved: false,
    })
    const [before] = await chat.listConversationEntries()

    await chat.resolveAlertThread(alert.id)

    expect(await chat.listConversationEntries()).toEqual([
      expect.objectContaining({
        id: before.id,
        content: 'A task needs attention',
        resolution: 'resolved',
      }),
    ])
  })
})
