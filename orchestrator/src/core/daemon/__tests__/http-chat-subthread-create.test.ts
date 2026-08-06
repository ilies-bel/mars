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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-chat-subthread-create-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const nullRecipeCatalog: RecipeCatalog = { get: () => null, list: () => [] }

describe('POST /chat/subthreads', () => {
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

  it('creates an inline Subthread with the situation report before the Operator message and starts its run', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const chatStore = await import('../../lib/chat-store')
    await chatStore.initChatStore()
    const sendMessage = vi.fn().mockResolvedValue({ alreadyRunning: false })
    const { startHttpServer } = await import('../http-server')
    server = await startHttpServer({
      chatRunner: { sendMessage } as unknown as ChatRunner,
      restartTask: async () => {}, remergeTask: async () => {}, unblockTask: async () => {},
      purgeTask: async () => {}, pruneWorktree: async () => {}, dismissProposal: async () => {},
      promoteProposal: async () => {}, validateTask: async () => {}, rejectTask: async () => {},
      landWork: async () => {}, investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }), restartDaemon: async () => {},
      continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }), isAcceptingWork: () => true, inFlightCount: () => 0,
      selfUpdate: async () => {}, runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {}, stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {}, recipeCatalog: nullRecipeCatalog, traceStore: nullTraceStore,
      appServices: stubAppServices({ buildSituationReport: async () => 'Situation: one task needs attention.' }),
    })

    const response = await fetch(`http://127.0.0.1:${server.port}/chat/subthreads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Please inspect the task.' }),
    })

    expect(response.status).toBe(202)
    const subthread = await response.json() as { id: string }
    const stored = await chatStore.getThread(subthread.id)
    expect(stored?.messages.map(({ role, kind, content }) => ({ role, kind, content }))).toEqual([
      { role: 'assistant', kind: 'situation', content: 'Situation: one task needs attention.' },
      { role: 'user', kind: 'acknowledgment', content: 'Please inspect the task.' },
    ])
    expect(sendMessage).toHaveBeenCalledWith(
      subthread.id,
      'Please inspect the task.',
      expect.any(String),
      undefined,
      undefined,
      { userMessagePersisted: true },
    )
  })

  it('does not create a Subthread when its situation report cannot be built', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const chatStore = await import('../../lib/chat-store')
    await chatStore.initChatStore()
    const sendMessage = vi.fn()
    const { startHttpServer } = await import('../http-server')
    server = await startHttpServer({
      chatRunner: { sendMessage } as unknown as ChatRunner,
      restartTask: async () => {}, remergeTask: async () => {}, unblockTask: async () => {},
      purgeTask: async () => {}, pruneWorktree: async () => {}, dismissProposal: async () => {},
      promoteProposal: async () => {}, validateTask: async () => {}, rejectTask: async () => {},
      landWork: async () => {}, investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }), restartDaemon: async () => {},
      continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }), isAcceptingWork: () => true, inFlightCount: () => 0,
      selfUpdate: async () => {}, runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {}, stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {}, recipeCatalog: nullRecipeCatalog, traceStore: nullTraceStore,
      appServices: stubAppServices({ buildSituationReport: async () => { throw new Error('unavailable') } }),
    })

    const response = await fetch(`http://127.0.0.1:${server.port}/chat/subthreads`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Keep my draft' }),
    })

    expect(response.status).toBe(500)
    expect(await chatStore.listThreads()).toEqual([])
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
