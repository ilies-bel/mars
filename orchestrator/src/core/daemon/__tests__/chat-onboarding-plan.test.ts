import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ChatRunner } from '../chat-runner'
import { CHAT_SYSTEM_PROMPT } from '../chat-system-prompt'
import type { StreamCodexResponseOpts } from '../codex-api'

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

vi.mock('../chat-system-prompt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat-system-prompt')>()
  return { ...actual, resolveChatSystemPrompt: vi.fn().mockResolvedValue({ prompt: 'TEST_SYSTEM_PROMPT', source: 'built-in' }) }
})

vi.mock('../codex-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../codex-api')>()
  return { ...actual, loadCodexAuth: vi.fn(), refreshCodexAuth: vi.fn(), streamCodexResponse: vi.fn() }
})

vi.mock('../chat-skills', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chat-skills')>()
  return { ...actual, discoverSkills: vi.fn() }
})

const mcpMock = vi.hoisted(() => ({ getTools: vi.fn(), call: vi.fn(), describe: vi.fn(), killAll: vi.fn() }))
vi.mock('../chat-mcp', () => ({
  ChatMcpManager: class {
    getTools = mcpMock.getTools
    call = mcpMock.call
    describe = mcpMock.describe
    killAll = mcpMock.killAll
  },
}))

vi.mock('../chat-shell', () => ({ runShellCommand: vi.fn() }))

vi.mock('../../lib/chat-store', () => ({
  appendMessage: vi.fn().mockResolvedValue({ id: 'msg-1', content: '', role: 'user', thread_id: 't1', segments: null, created_at: 0, kind: 'acknowledgment', backing_entity_id: null }),
  getThread: vi.fn(),
  setThreadStatus: vi.fn().mockResolvedValue(undefined),
  updateThreadTitle: vi.fn().mockResolvedValue(undefined),
}))

const codexApi = await import('../codex-api')
const chatSkills = await import('../chat-skills')
const { runShellCommand } = await import('../chat-shell')
const chatStore = await import('../../lib/chat-store')

const mockStream = codexApi.streamCodexResponse as unknown as MockInstance<
  (opts: StreamCodexResponseOpts) => Promise<void>
>
const mockShell = runShellCommand as unknown as MockInstance<
  (command: string, cwd: string, signal?: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr: string }>
>

const makeThreadFixture = (id: string) => ({
  thread: {
    id, title: '', status: 'idle' as const, posture: 'triage' as const, created_at: 0, updated_at: 0, origin: null,
    alert_item_id: null, alert_resolved: false, closed_at: null, parent_thread_id: null,
    fork_idempotency_key: null,
  },
  messages: [],
  feedbacks: new Map(),
})

const streamEmitting = (...events: unknown[]) => async (opts: StreamCodexResponseOpts): Promise<void> => {
  for (const event of events) opts.onEvent(event)
}

const firstSlicePlan = `First slice
\`\`\`text
Title: Create the project dashboard
What to build: Show the current work on a single dashboard.
Verification: npx vitest run src/dashboard.test.ts
\`\`\`
Reply "go" to queue this — or "skip" to end onboarding without queuing anything.`

describe('chat onboarding first-slice queue offer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(codexApi.loadCodexAuth).mockResolvedValue({ accessToken: 'tok', accountId: 'acc', refreshToken: 'ref' })
    vi.mocked(chatSkills.discoverSkills).mockResolvedValue([])
    mcpMock.getTools.mockResolvedValue([])
    vi.mocked(chatStore.getThread).mockImplementation(async (id) => makeThreadFixture(id))
    mockShell.mockImplementation(async (command) => ({
      exitCode: 0,
      stdout: command.startsWith('mars task add') ? 'queued mars-task-101' : 'vision set',
      stderr: '',
    }))
  })

  it('shows a first-slice plan after saving the Vision, then queues it only after go', async () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('After the Vision is captured')

    mockStream
      .mockImplementationOnce(streamEmitting(commandExecution('vision', 'mars vision set "Build a project dashboard"'), completedEvent()))
      .mockImplementationOnce(streamEmitting(agentMessage(firstSlicePlan), completedEvent()))
      .mockImplementationOnce(streamEmitting(commandExecution('task', 'mars task add "Create the project dashboard\n\nShow the current work on a single dashboard.\n\nVerify: npx vitest run src/dashboard.test.ts"'), completedEvent()))
      .mockImplementationOnce(streamEmitting(agentMessage('Queued mars-task-101.'), completedEvent()))

    const runner = new ChatRunner()
    await runner.sendMessage('onboarding-go', 'Build a project dashboard', '/repo', undefined)
    await vi.waitFor(() => expect(vi.mocked(chatStore.appendMessage).mock.calls.some((call) => call[1] === 'assistant')).toBe(true))

    const firstAssistant = vi.mocked(chatStore.appendMessage).mock.calls.find((call) => call[1] === 'assistant')!
    expect(firstAssistant[2]).toContain('First slice')
    expect(firstAssistant[2]).toContain('Title:')
    expect(firstAssistant[2]).toContain('What to build:')
    expect(firstAssistant[2]).toContain('Verification:')
    expect(firstAssistant[2]).toMatch(/Reply "go" to queue this/)
    expect(mockShell.mock.calls.map(([command]) => command)).toEqual(['mars vision set "Build a project dashboard"'])

    await runner.sendMessage('onboarding-go', 'go', '/repo', undefined)
    await vi.waitFor(() => expect(mockShell).toHaveBeenCalledTimes(2))

    expect(mockShell.mock.calls.map(([command]) => command)).toEqual([
      'mars vision set "Build a project dashboard"',
      'mars task add "Create the project dashboard\n\nShow the current work on a single dashboard.\n\nVerify: npx vitest run src/dashboard.test.ts"',
    ])
    const assistantReplies = vi.mocked(chatStore.appendMessage).mock.calls.filter((call) => call[1] === 'assistant')
    expect(assistantReplies.at(-1)![2]).toContain('mars-task-101')
  })

  it.each(['skip', 'not now'])('does not queue the plan when the operator replies %j', async (reply) => {
    mockStream
      .mockImplementationOnce(streamEmitting(commandExecution('vision', 'mars vision set "Build a project dashboard"'), completedEvent()))
      .mockImplementationOnce(streamEmitting(agentMessage(firstSlicePlan), completedEvent()))
      .mockImplementationOnce(streamEmitting(agentMessage('No task queued.'), completedEvent()))

    const runner = new ChatRunner()
    await runner.sendMessage('onboarding-no-go', 'Build a project dashboard', '/repo', undefined)
    await vi.waitFor(() => expect(vi.mocked(chatStore.appendMessage).mock.calls.some((call) => call[1] === 'assistant')).toBe(true))
    await runner.sendMessage('onboarding-no-go', reply, '/repo', undefined)
    await vi.waitFor(() => expect(vi.mocked(chatStore.appendMessage).mock.calls.filter((call) => call[1] === 'assistant')).toHaveLength(2))

    expect(mockShell.mock.calls.map(([command]) => command)).toEqual(['mars vision set "Build a project dashboard"'])
    expect(mockShell.mock.calls.map(([command]) => command)).not.toContain(expect.stringMatching(/^mars task add/))
  })
})
