/**
 * Behaviour tests for chat's triage-to-grill transition.
 *
 * A scripted chat turn talks to the runner through its public `sendMessage`
 * interface. The store mock represents the persistence boundary; the tests
 * assert the thread state and commands an operator can observe.
 */

import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { ChatRunner } from '../chat-runner'
import type { StreamCodexResponseOpts } from '../codex-api'

const messageEvent = (text: string): unknown => ({
  type: 'response.output_item.done',
  item: { type: 'message', content: [{ type: 'output_text', text }] },
})

const toolEvent = (callId: string, name: string, args: Record<string, unknown>): unknown => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) },
})

const completedEvent = (): unknown => ({
  type: 'response.completed',
  response: { usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } },
})

vi.mock('../chat-system-prompt', () => ({
  resolveChatSystemPrompt: vi.fn().mockResolvedValue({ prompt: 'TEST_SYSTEM_PROMPT', source: 'built-in' }),
}))

vi.mock('../codex-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codex-api')>()
  return { ...actual, loadCodexAuth: vi.fn(), refreshCodexAuth: vi.fn(), streamCodexResponse: vi.fn() }
})

vi.mock('../chat-skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat-skills')>()
  return { ...actual, discoverSkills: vi.fn() }
})

const mcpMock = vi.hoisted(() => ({
  getTools: vi.fn(), call: vi.fn(), describe: vi.fn(), killAll: vi.fn(),
}))
vi.mock('../chat-mcp', () => ({
  ChatMcpManager: class {
    getTools = mcpMock.getTools
    call = mcpMock.call
    describe = mcpMock.describe
    killAll = mcpMock.killAll
  },
}))

vi.mock('../../lib/git/claude', () => ({
  buildWorkerEnv: vi.fn(() => ({})),
  runSubprocessStreaming: vi.fn(),
}))

const store = vi.hoisted(() => ({
  posture: 'triage' as 'triage' | 'grill',
  appendMessage: vi.fn(),
  getThread: vi.fn(),
  setThreadPosture: vi.fn(),
  setThreadStatus: vi.fn(),
  updateThreadTitle: vi.fn(),
}))
vi.mock('../../lib/chat-store', () => store)

const codexApi = await import('../codex-api')
const chatSkills = await import('../chat-skills')
const { runSubprocessStreaming } = await import('../../lib/git/claude')

const mockStream = codexApi.streamCodexResponse as unknown as MockInstance<
  (opts: StreamCodexResponseOpts) => Promise<void>
>
const mockShell = runSubprocessStreaming as unknown as MockInstance<
  (cmd: string, args: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
>

const streamEmitting = (...events: unknown[]) => async (opts: StreamCodexResponseOpts): Promise<void> => {
  for (const event of events) opts.onEvent(event)
}

describe('ChatRunner posture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.posture = 'triage'
    store.appendMessage.mockResolvedValue({})
    store.setThreadPosture.mockImplementation(async (_threadId: string, posture: 'triage' | 'grill') => {
      store.posture = posture
    })
    store.setThreadStatus.mockResolvedValue(undefined)
    store.updateThreadTitle.mockResolvedValue(undefined)
    store.getThread.mockImplementation(async (id: string) => ({
      thread: {
        id, title: '', status: 'idle', posture: store.posture, created_at: '', updated_at: '',
        origin: null, alert_item_id: null, alert_resolved: false, closed_at: null,
        parent_thread_id: null, fork_idempotency_key: null, session_id: null,
      },
      messages: [],
      feedbacks: new Map(),
    }))
    vi.mocked(codexApi.loadCodexAuth).mockResolvedValue({ accessToken: 'token', accountId: 'account', refreshToken: 'refresh' })
    vi.mocked(chatSkills.discoverSkills).mockResolvedValue([])
    mcpMock.getTools.mockResolvedValue([])
    mockShell.mockResolvedValue({ exitCode: 0, stdout: 'queued task-1', stderr: '' })
  })

  it('keeps a concrete ask in triage and enqueues it once', async () => {
    mockStream
      .mockImplementationOnce(streamEmitting(toolEvent('task-1', 'shell', { command: 'mars task add "Rename the queue label"' }), completedEvent()))
      .mockImplementationOnce(streamEmitting(messageEvent('Queued task-1.'), completedEvent()))

    const runner = new ChatRunner()
    await runner.sendMessage('small', 'Rename the queue label', '/repo', undefined)

    await vi.waitFor(() => expect(store.appendMessage).toHaveBeenCalledWith(
      'small', 'assistant', 'Queued task-1.', expect.anything(),
    ))
    expect(store.posture).toBe('triage')
    expect(mockShell.mock.calls.filter(([, args]) => args[1]?.startsWith('mars task add'))).toHaveLength(1)
  })

  it('persists grill posture and announces the shift when the agent judges an ask hard', async () => {
    mockStream
      .mockImplementationOnce(streamEmitting(toolEvent('posture-1', 'set_posture', { posture: 'grill' }), completedEvent()))
      .mockImplementationOnce(streamEmitting(messageEvent('What problem should this redesign solve first?'), completedEvent()))

    const runner = new ChatRunner()
    await runner.sendMessage('hard', 'Rethink our cross-cutting queue strategy', '/repo', undefined)

    await vi.waitFor(() => expect(store.appendMessage).toHaveBeenCalledWith(
      'hard', 'assistant', 'What problem should this redesign solve first?', expect.anything(),
    ))
    expect(store.posture).toBe('grill')
    expect(store.appendMessage).toHaveBeenCalledWith(
      'hard', 'assistant', expect.stringContaining('grill posture'), expect.anything(),
    )
    expect(mockStream.mock.calls[1][0].tools.map((tool) => tool.name)).not.toContain('set_posture')
  })
})
