/**
 * Integration tests for POST /chat/threads/:id/message and
 * POST /chat/threads/:id/stop — verifying that the daemon HTTP server
 * correctly routes chat requests through the ChatRunner that is now a
 * required field of HttpServerDeps.
 *
 * Tests drive the behaviour through the real HTTP routes: the Codex API
 * is mocked at the boundary (streamCodexResponse) so no network or stored
 * credentials are needed, but the full route → ChatRunner → response path
 * is exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ChatRunner } from '../chat-runner'
import type { HttpServerHandle } from '../http-server'
import type { StreamCodexResponseOpts } from '../codex-api'
import { stubAppServices } from './app-services-stub'
import type { RecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

// Mock the Codex API layer so no network or stored credentials are needed.
vi.mock('../codex-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codex-api')>()
  return {
    ...actual,
    loadCodexAuth: vi.fn(),
    refreshCodexAuth: vi.fn(),
    streamCodexResponse: vi.fn(),
  }
})

describe('GET /view/chat/conversation', () => {
  it('serves the chronological cross-subject conversation projection', async () => {
    const { startHttpServer } = await import('../http-server')
    server = await startHttpServer({
      chatRunner: new ChatRunner(),
      restartTask: async () => {}, remergeTask: async () => {}, unblockTask: async () => {},
      purgeTask: async () => {}, pruneWorktree: async () => {}, dismissProposal: async () => {},
      promoteProposal: async () => {}, validateTask: async () => {}, rejectTask: async () => {},
      landWork: async () => {}, investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }), restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [], isAcceptingWork: () => true, inFlightCount: () => 0,
      selfUpdate: async () => {}, runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {}, stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {}, recipeCatalog: nullRecipeCatalog, traceStore: nullTraceStore,
      appServices: stubAppServices({
        viewChatConversation: async () => ({ entries: [{
          id: 'message-1', threadId: 'subject-1', subjectId: 'subject-1', subjectTitle: 'A subject', subjectClosed: false,
          role: 'assistant', content: 'Persisted narration', segments: [], createdAt: '2026-01-01T00:00:00.000Z',
          kind: 'acknowledgment', backingEntityId: null,
        }] }),
      }),
    })

    const response = await fetch(`http://127.0.0.1:${server.port}/view/chat/conversation`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ entries: [expect.objectContaining({
      subjectTitle: 'A subject', content: 'Persisted narration',
    })] })
  })
})

// Mock skill discovery so the run reaches the API layer without real fs I/O
// (the assertions below only wait a single setImmediate turn).
vi.mock('../chat-skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat-skills')>()
  return { ...actual, discoverSkills: vi.fn().mockResolvedValue([]) }
})

// Mock the MCP bridge for the same reason — it reads .mcp.json and spawns servers.
const mcpMock = vi.hoisted(() => ({ getTools: vi.fn(), call: vi.fn(), describe: vi.fn(), killAll: vi.fn() }))
vi.mock('../chat-mcp', () => ({
  ChatMcpManager: class {
    getTools = mcpMock.getTools
    call = mcpMock.call
    describe = mcpMock.describe
    killAll = mcpMock.killAll
  },
}))

// Mock the shell-tool executor so no real subprocess is spawned.
vi.mock('../../lib/git/claude', () => ({
  resolveClaudeBin: vi.fn(() => '/usr/bin/claude'),
  buildWorkerEnv: vi.fn(() => ({})),
  toClaudeSessionId: vi.fn((id: string) => id),
  runSubprocessStreaming: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}))

// Mock the chat store so no real database is created.
vi.mock('../../lib/chat-store', () => ({
  appendMessage: vi.fn().mockResolvedValue({
    id: 'msg-1',
    content: '',
    role: 'user',
    thread_id: 't1',
    segments: null,
    created_at: '',
  }),
  getThread: vi.fn().mockResolvedValue({
    thread: {
      id: 't1',
      title: '',
      status: 'idle',
      created_at: '',
      updated_at: '',
      origin: null,
      alert_item_id: null,
      alert_resolved: false,
      evaporated_at: null,
    },
    messages: [],
    feedbacks: new Map(),
  }),
  setThreadStatus: vi.fn().mockResolvedValue(undefined),
  updateThreadTitle: vi.fn().mockResolvedValue(undefined),
  setMessageFeedback: vi.fn().mockResolvedValue({
    message_id: 'msg-1',
    thread_id: 't1',
    rating: 'up',
    note: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }),
  clearMessageFeedback: vi.fn().mockResolvedValue(true),
}))

const codexApi = await import('../codex-api')
const mockStream = codexApi.streamCodexResponse as unknown as MockInstance<
  (opts: StreamCodexResponseOpts) => Promise<void>
>
const mockLoadAuth = codexApi.loadCodexAuth as unknown as MockInstance<() => Promise<unknown>>

const messageEvent = (text: string): unknown => ({
  type: 'response.output_item.done',
  item: { type: 'message', content: [{ type: 'output_text', text }] },
})

const { setMessageFeedback: mockSetMessageFeedback, clearMessageFeedback: mockClearMessageFeedback } =
  await import('../../lib/chat-store')

const nullRecipeCatalog: RecipeCatalog = {
  get: () => null,
  list: () => [],
}

let server: HttpServerHandle | null = null

beforeEach(async () => {
  vi.clearAllMocks()
  mockLoadAuth.mockResolvedValue({ accessToken: 'tok', accountId: 'acc', refreshToken: 'ref' })
  const chatSkills = await import('../chat-skills')
  vi.mocked(chatSkills.discoverSkills).mockResolvedValue([])
  mcpMock.getTools.mockResolvedValue([])
  mcpMock.describe.mockResolvedValue([])
  // Default: the API run completes immediately with one message.
  mockStream.mockImplementation(async (opts) => {
    opts.onEvent(messageEvent('ok'))
  })
})

afterEach(async () => {
  await server?.close()
  server = null
  vi.clearAllTimers()
})

describe('POST /chat/threads/:id/message — HTTP route wiring', () => {
  it('returns 202 and invokes the runner when a message is sent to a thread', async () => {
    const { startHttpServer } = await import('../http-server')
    const chatRunner = new ChatRunner()

    // Make the API run hang so we can inspect in-flight state.
    let resolveRun: () => void = () => {}
    mockStream.mockReturnValue(
      new Promise<void>((r) => {
        resolveRun = () => r()
      }),
    )

    server = await startHttpServer({
      chatRunner,
      restartTask: async () => {},
  remergeTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      dismissProposal: async () => {},
      promoteProposal: async () => {},
      validateTask: async () => {},
      rejectTask: async () => {},
  landWork: async () => {},
      investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }),
      restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [],
      isAcceptingWork: () => true,
      inFlightCount: () => 0,
      selfUpdate: async () => {},
      runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {},
      stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {},
      recipeCatalog: nullRecipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices(),
    })

    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/threads/t1/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hello' }),
      },
    )

    expect(res.status).toBe(202)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    // Verify the API layer was invoked — confirming ChatRunner was called.
    // (The run is still in-flight; wait for it to reach the API layer — a
    // single setImmediate loses the race when the threadpool is loaded.)
    await vi.waitFor(() => expect(mockStream).toHaveBeenCalled())

    // Clean up.
    resolveRun()
  })

  it('returns 409 when a run is already active on the thread', async () => {
    const { startHttpServer } = await import('../http-server')
    const chatRunner = new ChatRunner()

    // Hang the first API run.
    let resolveFirst: () => void = () => {}
    mockStream.mockReturnValue(
      new Promise<void>((r) => {
        resolveFirst = () => r()
      }),
    )

    server = await startHttpServer({
      chatRunner,
      restartTask: async () => {},
  remergeTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      dismissProposal: async () => {},
      promoteProposal: async () => {},
      validateTask: async () => {},
      rejectTask: async () => {},
  landWork: async () => {},
      investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }),
      restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [],
      isAcceptingWork: () => true,
      inFlightCount: () => 0,
      selfUpdate: async () => {},
      runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {},
      stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {},
      recipeCatalog: nullRecipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices(),
    })

    // First request — starts the run.
    const first = await fetch(
      `http://127.0.0.1:${server.port}/chat/threads/t1/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'first' }),
      },
    )
    expect(first.status).toBe(202)

    // Let ChatRunner register the active run (drain microtasks).
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    // Second request while first is still running — should get 409.
    const second = await fetch(
      `http://127.0.0.1:${server.port}/chat/threads/t1/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'second' }),
      },
    )
    expect(second.status).toBe(409)
    const body = (await second.json()) as { errorCode: string }
    expect(body.errorCode).toBe('ALREADY_RUNNING')

    resolveFirst()
  })

  it('returns 400 when the message body is missing content', async () => {
    const { startHttpServer } = await import('../http-server')
    const chatRunner = new ChatRunner()

    server = await startHttpServer({
      chatRunner,
      restartTask: async () => {},
  remergeTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      dismissProposal: async () => {},
      promoteProposal: async () => {},
      validateTask: async () => {},
      rejectTask: async () => {},
  landWork: async () => {},
      investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }),
      restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [],
      isAcceptingWork: () => true,
      inFlightCount: () => 0,
      selfUpdate: async () => {},
      runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {},
      stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {},
      recipeCatalog: nullRecipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices(),
    })

    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/threads/t1/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '' }),  // empty string with no attachments fails the refine check
      },
    )
    expect(res.status).toBe(400)
  })

  it('returns 202 when content is empty but at least one attachment is provided (attachment-only message)', async () => {
    const { startHttpServer } = await import('../http-server')
    const chatRunner = new ChatRunner()

    mockStream.mockImplementation(async (opts) => {
      opts.onEvent(messageEvent('ok'))
    })

    server = await startHttpServer({
      chatRunner,
      restartTask: async () => {},
      remergeTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      dismissProposal: async () => {},
      promoteProposal: async () => {},
      validateTask: async () => {},
      rejectTask: async () => {},
  landWork: async () => {},
      investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }),
      restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [],
      isAcceptingWork: () => true,
      inFlightCount: () => 0,
      selfUpdate: async () => {},
      runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {},
      stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {},
      recipeCatalog: nullRecipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices(),
    })

    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/threads/t1/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: '',
          attachments: [
            { id: 'att-1', path: '/tmp/upload.png', mimeType: 'image/png', name: 'photo.png', size: 2048 },
          ],
        }),
      },
    )
    expect(res.status).toBe(202)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('passes the full attachment metadata to ChatRunner when sending with attachments', async () => {
    const { startHttpServer } = await import('../http-server')

    // Spy on chatRunner.sendMessage to verify it receives the attachment array.
    const chatRunner = new ChatRunner()
    const sendMessageSpy = vi.spyOn(chatRunner, 'sendMessage')

    let resolveRun: () => void = () => {}
    mockStream.mockReturnValue(
      new Promise<void>((r) => {
        resolveRun = () => r()
      }),
    )

    server = await startHttpServer({
      chatRunner,
      restartTask: async () => {},
      remergeTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      dismissProposal: async () => {},
      promoteProposal: async () => {},
      validateTask: async () => {},
      rejectTask: async () => {},
  landWork: async () => {},
      investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }),
      restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [],
      isAcceptingWork: () => true,
      inFlightCount: () => 0,
      selfUpdate: async () => {},
      runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {},
      stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {},
      recipeCatalog: nullRecipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices(),
    })

    const attachment = { id: 'att-1', path: '/tmp/upload.png', mimeType: 'image/png', name: 'photo.png', size: 2048 }

    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/threads/t1/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'check this image', attachments: [attachment] }),
      },
    )
    expect(res.status).toBe(202)

    // Verify ChatRunner.sendMessage received the attachments array.
    await vi.waitFor(() => expect(sendMessageSpy).toHaveBeenCalled())
    const [, , , , receivedAttachments] = sendMessageSpy.mock.calls[0]
    expect(receivedAttachments).toEqual([attachment])

    resolveRun()
  })

  it('returns 400 when the body uses the wrong field name { text } instead of { content }', async () => {
    const { startHttpServer } = await import('../http-server')
    const chatRunner = new ChatRunner()

    server = await startHttpServer({
      chatRunner,
      restartTask: async () => {},
  remergeTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      dismissProposal: async () => {},
      promoteProposal: async () => {},
      validateTask: async () => {},
      rejectTask: async () => {},
  landWork: async () => {},
      investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }),
      restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [],
      isAcceptingWork: () => true,
      inFlightCount: () => 0,
      selfUpdate: async () => {},
      runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {},
      stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {},
      recipeCatalog: nullRecipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices(),
    })

    // Sending { text } instead of { content } must be rejected: the daemon
    // contract requires { content: string } and any deviation must 400.
    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/threads/t1/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      },
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/content/)
  })
})

describe('POST /chat/threads/:id/stop — HTTP route wiring', () => {
  it('returns 200 with stopped=false when no run is active', async () => {
    const { startHttpServer } = await import('../http-server')
    const chatRunner = new ChatRunner()

    server = await startHttpServer({
      chatRunner,
      restartTask: async () => {},
  remergeTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      dismissProposal: async () => {},
      promoteProposal: async () => {},
      validateTask: async () => {},
      rejectTask: async () => {},
  landWork: async () => {},
      investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }),
      restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [],
      isAcceptingWork: () => true,
      inFlightCount: () => 0,
      selfUpdate: async () => {},
      runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {},
      stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {},
      recipeCatalog: nullRecipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices(),
    })

    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/threads/t1/stop`,
      { method: 'POST' },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; stopped: boolean }
    expect(body.ok).toBe(true)
    expect(body.stopped).toBe(false)
  })

  it('returns 200 with stopped=true after stopping an active run', async () => {
    const { startHttpServer } = await import('../http-server')
    const chatRunner = new ChatRunner()

    // The API run waits for the abort signal.
    mockStream.mockImplementation(
      (opts) =>
        new Promise<void>((_, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        }),
    )

    server = await startHttpServer({
      chatRunner,
      restartTask: async () => {},
  remergeTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      dismissProposal: async () => {},
      promoteProposal: async () => {},
      validateTask: async () => {},
      rejectTask: async () => {},
  landWork: async () => {},
      investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }),
      restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [],
      isAcceptingWork: () => true,
      inFlightCount: () => 0,
      selfUpdate: async () => {},
      runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {},
      stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {},
      recipeCatalog: nullRecipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices(),
    })

    // Start a run.
    const startRes = await fetch(
      `http://127.0.0.1:${server.port}/chat/threads/t1/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hello' }),
      },
    )
    expect(startRes.status).toBe(202)

    // Let the run register in the ChatRunner (drain microtasks).
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    // Now stop it.
    const stopRes = await fetch(
      `http://127.0.0.1:${server.port}/chat/threads/t1/stop`,
      { method: 'POST' },
    )

    expect(stopRes.status).toBe(200)
    const body = (await stopRes.json()) as { ok: boolean; stopped: boolean }
    expect(body.ok).toBe(true)
    expect(body.stopped).toBe(true)
  })

  it('reconciles a stale running row to idle when no live run exists', async () => {
    // Simulate a thread whose DB row is stuck at 'running' from a prior
    // daemon crash, with no in-memory run registered.
    const { getThread: mockGetThread, setThreadStatus: mockSetThreadStatus } =
      await import('../../lib/chat-store')
    const getThreadMock = mockGetThread as ReturnType<typeof vi.fn>
    const setThreadStatusMock = mockSetThreadStatus as ReturnType<typeof vi.fn>

    getThreadMock.mockResolvedValueOnce({
      thread: {
        id: 't1',
        title: '',
        status: 'running',
        created_at: '',
        updated_at: '',
        origin: null,
        alert_item_id: null,
        alert_resolved: false,
        evaporated_at: null,
      },
      messages: [],
      feedbacks: new Map(),
    })

    const { startHttpServer } = await import('../http-server')
    const chatRunner = new ChatRunner()

    server = await startHttpServer({
      chatRunner,
      restartTask: async () => {},
  remergeTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      dismissProposal: async () => {},
      promoteProposal: async () => {},
      validateTask: async () => {},
      rejectTask: async () => {},
  landWork: async () => {},
      investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }),
      restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [],
      isAcceptingWork: () => true,
      inFlightCount: () => 0,
      selfUpdate: async () => {},
      runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {},
      stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {},
      recipeCatalog: nullRecipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices(),
    })

    // No active run — chatRunner.stop returns false.
    const stopRes = await fetch(
      `http://127.0.0.1:${server.port}/chat/threads/t1/stop`,
      { method: 'POST' },
    )

    expect(stopRes.status).toBe(200)
    const body = (await stopRes.json()) as { ok: boolean; stopped: boolean }
    expect(body.ok).toBe(true)
    expect(body.stopped).toBe(false)

    // The route should have reconciled the stale row to 'idle'.
    expect(setThreadStatusMock).toHaveBeenCalledWith('t1', 'idle')
  })
})

// ---------------------------------------------------------------------------
// Feedback routes
// ---------------------------------------------------------------------------

/** Start a minimal server for feedback route tests. */
const startFeedbackServer = async () => {
  const { startHttpServer } = await import('../http-server')
  return startHttpServer({
    chatRunner: new ChatRunner(),
    restartTask: async () => {},
  remergeTask: async () => {},
    unblockTask: async () => {},
    snoozeItem: async () => {},
    purgeTask: async () => {},
    pruneWorktree: async () => {},
    dismissProposal: async () => {},
    promoteProposal: async () => {},
    validateTask: async () => {},
    rejectTask: async () => {},
  landWork: async () => {},
    investigateWorktree: async () => ({ explanation: '' }),
    diagnoseFailure: async () => ({ diagnosis: '' }),
    restartDaemon: async () => {},
    restartAllDaemonKilled: async () => [],
    isAcceptingWork: () => true,
    inFlightCount: () => 0,
    selfUpdate: async () => {},
    runReflect: async () => ({ proposalsRaised: 0 }),
    enableAutoReflect: async () => {},
    stepDone: async () => ({ next: null as string | null }),
    recipeCatalog: nullRecipeCatalog,
    traceStore: nullTraceStore,
    appServices: stubAppServices(),
  })
}

describe('POST /chat/messages/:id/feedback — HTTP route wiring', () => {
  it('returns 200 with the stored feedback on a valid up rating', async () => {
    server = await startFeedbackServer()

    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/messages/msg-1/feedback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 'up' }),
      },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; feedback: { rating: string } }
    expect(body.ok).toBe(true)
    expect(body.feedback.rating).toBe('up')
    expect(mockSetMessageFeedback).toHaveBeenCalledWith('msg-1', 'up', null)
  })

  it('returns 200 with a note when note is provided', async () => {
    server = await startFeedbackServer()

    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/messages/msg-1/feedback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 'down', note: 'wrong answer' }),
      },
    )

    expect(res.status).toBe(200)
    expect(mockSetMessageFeedback).toHaveBeenCalledWith('msg-1', 'down', 'wrong answer')
  })

  it('returns 400 when rating is missing', async () => {
    server = await startFeedbackServer()

    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/messages/msg-1/feedback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'no rating provided' }),
      },
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(false)
  })

  it('returns 400 when rating is invalid', async () => {
    server = await startFeedbackServer()

    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/messages/msg-1/feedback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 'maybe' }),
      },
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(false)
  })

  it('returns 404 when the message does not exist', async () => {
    ;(mockSetMessageFeedback as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('message unknown-msg not found'),
    )
    server = await startFeedbackServer()

    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/messages/unknown-msg/feedback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 'up' }),
      },
    )

    expect(res.status).toBe(404)
    const body = (await res.json()) as { ok: boolean; errorCode: string }
    expect(body.ok).toBe(false)
    expect(body.errorCode).toBe('NOT_FOUND')
  })
})

describe('POST /chat/messages/:id/feedback/clear — HTTP route wiring', () => {
  it('returns 200 with cleared=true when feedback existed', async () => {
    server = await startFeedbackServer()

    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/messages/msg-1/feedback/clear`,
      { method: 'POST' },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; cleared: boolean }
    expect(body.ok).toBe(true)
    expect(body.cleared).toBe(true)
    expect(mockClearMessageFeedback).toHaveBeenCalledWith('msg-1')
  })

  it('returns 200 with cleared=false when no feedback existed (idempotent)', async () => {
    ;(mockClearMessageFeedback as unknown as { mockResolvedValueOnce: (v: boolean) => void }).mockResolvedValueOnce(false)
    server = await startFeedbackServer()

    const res = await fetch(
      `http://127.0.0.1:${server.port}/chat/messages/no-feedback/feedback/clear`,
      { method: 'POST' },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; cleared: boolean }
    expect(body.ok).toBe(true)
    expect(body.cleared).toBe(false)
  })
})

describe('GET /view/chat/config — HTTP route wiring', () => {
  it('returns the agent configuration from ChatRunner.describeConfig', async () => {
    const { startHttpServer } = await import('../http-server')
    mcpMock.describe.mockResolvedValue([
      { name: 'codegraph', command: 'codegraph serve --mcp', status: 'connected', tools: [{ name: 'codegraph_search', description: 'Find.' }] },
    ])
    server = await startHttpServer({
      chatRunner: new ChatRunner(),
      restartTask: async () => {},
      remergeTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      dismissProposal: async () => {},
      promoteProposal: async () => {},
      validateTask: async () => {},
      rejectTask: async () => {},
  landWork: async () => {},
      investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }),
      restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [],
      isAcceptingWork: () => true,
      inFlightCount: () => 0,
      selfUpdate: async () => {},
      runReflect: async () => ({ proposalsRaised: 0 }),
      enableAutoReflect: async () => {},
      stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {},
      recipeCatalog: nullRecipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices(),
    })

    const res = await fetch(`http://127.0.0.1:${server.port}/view/chat/config`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      model: string
      systemPrompt: string
      systemPromptSource: string
      builtinTools: Array<{ name: string }>
      skills: unknown[]
      mcpServers: Array<{ name: string; status: string }>
    }
    expect(body.model).toBe('gpt-5.5')
    expect(body.systemPromptSource).toBe('built-in')
    expect(body.systemPrompt.length).toBeGreaterThan(0)
    expect(body.builtinTools.map((t) => t.name)).toEqual(['shell', 'read_file', 'write_file', 'skill'])
    expect(body.mcpServers).toEqual([
      { name: 'codegraph', command: 'codegraph serve --mcp', status: 'connected', tools: [{ name: 'codegraph_search', description: 'Find.' }] },
    ])
  })
})
