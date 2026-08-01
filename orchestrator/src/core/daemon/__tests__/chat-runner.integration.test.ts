/**
 * Integration-style tests for the chat-runner end-to-end flow.
 *
 * These tests prove the full vertical slice: a scripted Codex SSE event
 * stream → parseEventToSegments → ChatRunner tool-execution loop →
 * accumulated ChatSegments persisted via appendMessage.
 *
 * Two scenarios are covered:
 *  1. agent runs `mars restart T-42` (safe mutation) → executed tool_use +
 *     tool_result with isError:false
 *  2. agent runs `mars propose purge T-42` (destructive) → single proposed
 *     tool_use, no tool_result
 */

import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { parseEventToSegments, ChatRunner } from '../chat-runner'
import { type StreamCodexResponseOpts } from '../codex-api'

// ── SSE event helpers ─────────────────────────────────────────────────────────

const agentMessage = (text: string): unknown => ({
  type: 'response.output_item.done',
  item: { type: 'message', content: [{ type: 'output_text', text }] },
})

const commandExecution = (callId: string, command: string): unknown => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', call_id: callId, name: 'shell', arguments: JSON.stringify({ command }) },
})

const completedEvent = (): unknown => ({
  type: 'response.completed',
  response: { usage: { input_tokens: 5, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } },
})

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../chat-system-prompt', () => ({
  resolveChatSystemPrompt: vi.fn().mockResolvedValue({ prompt: 'TEST_SYSTEM_PROMPT', source: 'built-in' }),
}))

vi.mock('../codex-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codex-api')>()
  return {
    ...actual,
    loadCodexAuth: vi.fn(),
    refreshCodexAuth: vi.fn(),
    streamCodexResponse: vi.fn(),
  }
})

vi.mock('../chat-skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat-skills')>()
  return { ...actual, discoverSkills: vi.fn() }
})

const mcpMock = vi.hoisted(() => ({
  getTools: vi.fn(),
  call: vi.fn(),
  describe: vi.fn(),
  killAll: vi.fn(),
}))
vi.mock('../chat-mcp', () => ({
  ChatMcpManager: class {
    getTools = mcpMock.getTools
    call = mcpMock.call
    describe = mcpMock.describe
    killAll = mcpMock.killAll
  },
}))

vi.mock('../chat-shell', () => ({
  runShellCommand: vi.fn(),
}))

vi.mock('../../lib/chat-store', () => ({
  appendMessage: vi.fn().mockResolvedValue({ id: 'msg-1', content: '', role: 'user', thread_id: 't1', segments: null, created_at: 0, kind: 'acknowledgment', backing_entity_id: null }),
  getThread: vi.fn(),
  listMainThreadMessages: vi.fn().mockResolvedValue([]),
  setThreadStatus: vi.fn().mockResolvedValue(undefined),
  updateThreadTitle: vi.fn().mockResolvedValue(undefined),
}))

// Import mocked modules after vi.mock declarations (hoisting order matters).
const codexApi = await import('../codex-api')
const chatSkills = await import('../chat-skills')
const { runShellCommand } = await import('../chat-shell')
const chatStore = await import('../../lib/chat-store')

const mockStream = codexApi.streamCodexResponse as unknown as MockInstance<
  (opts: StreamCodexResponseOpts) => Promise<void>
>
const mockLoadAuth = codexApi.loadCodexAuth as unknown as MockInstance<() => Promise<unknown>>
const mockShell = runShellCommand as unknown as MockInstance<
  (
    command: string,
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
>

const AUTH = { accessToken: 'tok', accountId: 'acc', refreshToken: 'ref' }

const makeThreadFixture = (id: string) => ({
  thread: {
    id,
    title: '',
    status: 'idle' as const,
    posture: 'triage' as const,
    created_at: 0,
    updated_at: 0,
    origin: null,
    alert_item_id: null,
    alert_resolved: false,
    objective: null,
    archived_at: null,
    closed_at: null,
    parent_thread_id: null,
    fork_idempotency_key: null,
  },
  messages: [],
  feedbacks: new Map(),
})

const streamEmitting = (...events: unknown[]) =>
  async (opts: StreamCodexResponseOpts): Promise<void> => {
    for (const ev of events) opts.onEvent(ev)
  }

// ── parseEventToSegments — direct event chain for mars restart T-42 ───────────

describe('parseEventToSegments — mars restart T-42 event chain', () => {
  it('maps agent_message → text and command_execution(mars restart T-42) → tool_use', () => {
    // Scripted Codex event stream: agent_message + command_execution
    const events = [
      agentMessage("I'll restart it."),
      commandExecution('call-restart', 'mars restart T-42'),
    ]

    const segments = events.flatMap(parseEventToSegments)

    const textSeg = segments.find((s) => s.type === 'text')
    expect(textSeg).toMatchObject({ type: 'text', text: "I'll restart it." })

    const toolUseSeg = segments.find((s) => s.type === 'tool_use')
    expect(toolUseSeg).toMatchObject({
      type: 'tool_use',
      name: 'mars restart',
      input: { command: 'mars restart T-42' },
      status: 'executed',
    })
  })
})

// ── ChatRunner integration — full segment accumulation ───────────────────────

describe('ChatRunner integration — task-blocked "can you retry?"', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadAuth.mockResolvedValue(AUTH)
    vi.mocked(chatSkills.discoverSkills).mockResolvedValue([])
    mcpMock.getTools.mockResolvedValue([])
    vi.mocked(chatStore.appendMessage).mockResolvedValue({
      id: 'msg-1', content: '', role: 'user', thread_id: 't1', segments: null, created_at: 0,
      context_scope: 'subthread', kind: 'acknowledgment', backing_entity_id: null,
    })
  })

  it('accumulates a tool_use for mars restart followed by tool_result with isError: false', async () => {
    vi.mocked(chatStore.getThread).mockResolvedValue(makeThreadFixture('t1'))

    // Turn 1: agent says "I'll restart it." then calls mars restart T-42.
    // Turn 2: agent confirms with a final text message.
    mockStream
      .mockImplementationOnce(streamEmitting(
        agentMessage("I'll restart it."),
        commandExecution('call-restart', 'mars restart T-42'),
        completedEvent(),
      ))
      .mockImplementationOnce(streamEmitting(
        agentMessage('Task T-42 has been restarted.'),
        completedEvent(),
      ))

    // command_execution_output(exit 0): shell returns success.
    mockShell.mockResolvedValue({ exitCode: 0, stdout: 'restarted', stderr: '' })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'Can you retry task T-42?', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const assistantCall = vi.mocked(chatStore.appendMessage).mock.calls.find((c) => c[1] === 'assistant')
    expect(assistantCall).toBeDefined()
    const segments = assistantCall![3] as Array<{
      type: string
      name?: string
      input?: unknown
      isError?: boolean
      status?: string
    }>

    const toolUse = segments.find((s) => s.type === 'tool_use')
    expect(toolUse).toMatchObject({
      type: 'tool_use',
      name: 'mars restart',
      input: { command: 'mars restart T-42' },
    })

    const toolResult = segments.find((s) => s.type === 'tool_result')
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      isError: false,
    })
  })

  it('produces a single proposed tool_use with no tool_result for mars propose purge T-42', async () => {
    vi.mocked(chatStore.getThread).mockResolvedValue(makeThreadFixture('t2'))

    // The mars propose CLI wrapper emits a mars-propose envelope on stdout.
    const envelope = JSON.stringify({
      kind: 'mars-propose',
      verb: 'purge',
      args: ['T-42'],
      proposalId: 'prop-1',
    })

    // Turn 1: agent calls mars propose purge T-42 (destructive — wrapped in propose).
    // Turn 2: agent explains what was proposed.
    mockStream
      .mockImplementationOnce(streamEmitting(
        commandExecution('call-propose', 'mars propose purge T-42'),
        completedEvent(),
      ))
      .mockImplementationOnce(streamEmitting(
        agentMessage('Proposed purging T-42 for your review.'),
        completedEvent(),
      ))

    mockShell.mockResolvedValue({ exitCode: 0, stdout: envelope, stderr: '' })

    const runner = new ChatRunner()
    await runner.sendMessage('t2', 'Purge task T-42', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const assistantCall = vi.mocked(chatStore.appendMessage).mock.calls.find((c) => c[1] === 'assistant')
    expect(assistantCall).toBeDefined()
    const segments = assistantCall![3] as Array<{ type: string; status?: string; name?: string }>

    const toolUseSegs = segments.filter((s) => s.type === 'tool_use')
    const toolResultSegs = segments.filter((s) => s.type === 'tool_result')

    expect(toolUseSegs).toHaveLength(1)
    expect(toolUseSegs[0]).toMatchObject({
      type: 'tool_use',
      status: 'proposed',
      name: 'mars purge',
    })
    expect(toolResultSegs).toHaveLength(0)
  })
})
