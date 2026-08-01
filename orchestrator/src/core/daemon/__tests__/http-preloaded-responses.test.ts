import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { ChatRunner } from '../chat-runner'
import type { HttpServerHandle } from '../http-server'
import type { RecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'
import { stubAppServices } from './app-services-stub'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-preloaded-response-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const nullRecipeCatalog: RecipeCatalog = { get: () => null, list: () => [] }

describe('POST /chat/messages/:messageId/responses/:responseId', () => {
  let repo: string
  let server: HttpServerHandle | null = null

  beforeEach(() => { repo = setupRepo() })
  afterEach(async () => {
    await server?.close()
    server = null
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('executes a safe verb and writes a zero-token Operator acknowledgment without starting ChatRunner', async () => {
    process.env.MARS_REPO = repo
    const chatStore = await import('../../lib/chat-store')
    await chatStore.initChatStore()
    const subject = await chatStore.createThread('Queue maintenance')
    const notice = await chatStore.appendMessage(
      subject.id,
      'assistant',
      'A task is ready to restart.',
      [{
        type: 'preloaded_responses',
        responses: [{
          id: 'restart-task',
          label: 'Restart it',
          target: { type: 'verb', op: 'restart', entityId: 'task-42' },
        }],
      }],
      { kind: 'notice', contextScope: 'main' },
    )
    const restartTask = vi.fn().mockResolvedValue(undefined)
    const sendMessage = vi.fn()
    const { startHttpServer } = await import('../http-server')
    server = await startHttpServer({
      chatRunner: { sendMessage } as unknown as ChatRunner,
      restartTask, remergeTask: async () => {}, unblockTask: async () => {},
      purgeTask: async () => {}, pruneWorktree: async () => {}, dismissProposal: async () => {},
      promoteProposal: async () => {}, validateTask: async () => {}, rejectTask: async () => {},
      landWork: async () => {}, investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }), restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [], isAcceptingWork: () => true, inFlightCount: () => 0,
      selfUpdate: async () => {}, runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {}, stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {}, recipeCatalog: nullRecipeCatalog, traceStore: nullTraceStore,
      appServices: stubAppServices(),
    })

    const response = await fetch(
      `http://127.0.0.1:${server.port}/chat/messages/${notice.id}/responses/restart-task`,
      { method: 'POST' },
    )

    expect(response.status).toBe(200)
    expect(restartTask).toHaveBeenCalledWith('task-42')
    expect(sendMessage).not.toHaveBeenCalled()
    const stored = await chatStore.getThread(subject.id)
    expect(stored?.messages.map(({ role, kind, content, context_scope }) => ({ role, kind, content, context_scope }))).toEqual([
      { role: 'assistant', kind: 'notice', content: 'A task is ready to restart.', context_scope: 'main' },
      { role: 'user', kind: 'acknowledgment', content: 'Restart it', context_scope: 'main' },
    ])
    expect(chatStore.toMessageApiView(stored!.messages[1]!).turnTokens).toBe(0)
  })

  it('opens a Subject through the situation service without starting ChatRunner', async () => {
    process.env.MARS_REPO = repo
    const chatStore = await import('../../lib/chat-store')
    await chatStore.initChatStore()
    const subject = await chatStore.createThread('Queue maintenance')
    const notice = await chatStore.appendMessage(subject.id, 'assistant', 'Review this task?', [{
      type: 'preloaded_responses',
      responses: [{
        id: 'review-task',
        label: 'Review task',
        target: { type: 'subject', title: 'Review task-42' },
      }],
    }], { kind: 'notice', contextScope: 'main' })
    const openSubject = vi.fn().mockResolvedValue({ threadId: 'subject-review' })
    const sendMessage = vi.fn()
    const { startHttpServer } = await import('../http-server')
    server = await startHttpServer({
      chatRunner: { sendMessage } as unknown as ChatRunner,
      restartTask: async () => {}, remergeTask: async () => {}, unblockTask: async () => {},
      purgeTask: async () => {}, pruneWorktree: async () => {}, dismissProposal: async () => {},
      promoteProposal: async () => {}, validateTask: async () => {}, rejectTask: async () => {},
      landWork: async () => {}, investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }), restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [], isAcceptingWork: () => true, inFlightCount: () => 0,
      selfUpdate: async () => {}, runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {}, stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {}, recipeCatalog: nullRecipeCatalog, traceStore: nullTraceStore,
      appServices: stubAppServices({ openSubject }),
    })

    const response = await fetch(
      `http://127.0.0.1:${server.port}/chat/messages/${notice.id}/responses/review-task`,
      { method: 'POST' },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ threadId: 'subject-review' })
    expect(openSubject).toHaveBeenCalledWith({ title: 'Review task-42', acknowledgment: 'Review task' })
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
