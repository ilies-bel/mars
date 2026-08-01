/**
 * Behaviour tests for chat's explicit escape hatches from ordinary routing.
 *
 * The scripted agent streams invoke the runner through its public
 * `sendMessage` interface. Queue/proposal/purge stores are the persistence
 * boundaries; assertions cover the commands and notices an operator sees.
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

const queue = vi.hoisted(() => ({
  enqueueTask: vi.fn(), getTask: vi.fn(), updateTask: vi.fn(),
}))
vi.mock('../../queue', () => queue)

const threadTasks = vi.hoisted(() => ({ listTasksForThread: vi.fn() }))
vi.mock('../chat-thread-tasks', () => threadTasks)

const purge = vi.hoisted(() => ({ corePurgeTask: vi.fn() }))
vi.mock('../purge-task', () => purge)

const proposals = vi.hoisted(() => ({ createProposal: vi.fn() }))
vi.mock('../../proposals', () => proposals)

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

const mockStream = codexApi.streamCodexResponse as unknown as MockInstance<
  (opts: StreamCodexResponseOpts) => Promise<void>
>

const streamEmitting = (...events: unknown[]) => async (opts: StreamCodexResponseOpts): Promise<void> => {
  for (const event of events) opts.onEvent(event)
}

describe('ChatRunner overrides', () => {
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
      messages: [], feedbacks: new Map(),
    }))
    vi.mocked(codexApi.loadCodexAuth).mockResolvedValue({ accessToken: 'token', accountId: 'account', refreshToken: 'refresh' })
    vi.mocked(chatSkills.discoverSkills).mockResolvedValue([])
    mcpMock.getTools.mockResolvedValue([])
    threadTasks.listTasksForThread.mockResolvedValue([])
  })

  it('turns “just do it” in a grill into one task and returns the thread to triage', async () => {
    store.posture = 'grill'
    queue.enqueueTask.mockResolvedValue({ id: 'task-17' })
    mockStream
      .mockImplementationOnce(streamEmitting(
        toolEvent('end-grill', 'override_end_grill', { taskSpec: 'Rename the queue label.' }),
        completedEvent(),
      ))
      .mockImplementationOnce(streamEmitting(messageEvent('Queued task-17.'), completedEvent()))

    const runner = new ChatRunner()
    await runner.sendMessage('grill', 'just do it', '/repo', undefined)

    await vi.waitFor(() => expect(store.appendMessage).toHaveBeenCalledWith(
      'grill', 'assistant', 'Queued task-17.', expect.anything(),
    ))
    expect(queue.enqueueTask).toHaveBeenCalledTimes(1)
    expect(queue.enqueueTask).toHaveBeenCalledWith(
      'Rename the queue label.', undefined, { skipTriage: true, chatThreadId: 'grill' },
    )
    expect(store.posture).toBe('triage')
    expect(store.appendMessage).toHaveBeenCalledWith(
      'grill', 'assistant', expect.stringContaining('left grill posture'), expect.anything(),
    )
  })

  it('replaces an enqueued small task with a proposal when follow-up makes it hard', async () => {
    queue.getTask.mockResolvedValue({ id: 'task-18', prompt: 'Rename the queue label.', status: 'queued' })
    queue.updateTask.mockResolvedValue(undefined)
    purge.corePurgeTask.mockResolvedValue({ taskId: 'task-18' })
    proposals.createProposal.mockResolvedValue({ id: 'proposal-9' })
    mockStream
      .mockImplementationOnce(streamEmitting(
        toolEvent('reshape', 'override_reshape_as_proposal', {
          originalTaskId: 'task-18',
          proposalDraft: 'Rethink queue terminology across the product',
        }),
        completedEvent(),
      ))
      .mockImplementationOnce(streamEmitting(messageEvent('I moved this into a proposal.'), completedEvent()))

    const runner = new ChatRunner()
    await runner.sendMessage('triage', 'Actually this changes our whole vocabulary.', '/repo', undefined)

    await vi.waitFor(() => expect(store.appendMessage).toHaveBeenCalledWith(
      'triage', 'assistant', 'I moved this into a proposal.', expect.anything(),
    ))
    expect(queue.updateTask).toHaveBeenCalledWith('task-18', { status: 'dropped', dropReason: 'superseded' })
    expect(purge.corePurgeTask).toHaveBeenCalledWith('task-18', false, 'main', '/repo')
    expect(proposals.createProposal).toHaveBeenCalledWith(
      'Rethink queue terminology across the product',
      expect.objectContaining({ notes: expect.stringContaining('Rename the queue label.') }),
    )
    expect(purge.corePurgeTask.mock.invocationCallOrder[0]).toBeLessThan(proposals.createProposal.mock.invocationCallOrder[0])
    expect(store.appendMessage).toHaveBeenCalledWith(
      'triage', 'assistant', expect.stringContaining('replaced task task-18'), expect.anything(),
    )
  })
})
