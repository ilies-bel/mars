/**
 * Tests for chat-runner.ts — Responses SSE parser, transcript replay, and the
 * run state machine.
 *
 * Parser tests: pure unit tests over `parseEventToSegments` fed with
 * synthetic Codex Responses SSE fixtures.
 *
 * State machine tests: drive the `ChatRunner` class with a mocked codex-api
 * layer (loadCodexAuth / refreshCodexAuth / streamCodexResponse) and a mocked
 * shell executor to assert the tool loop, 409 on concurrent runs, stop
 * finalisation, throttle/auth handling, and timeout finalisation.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'
import { parseEventToSegments, buildApiInput, ChatRunner, CHAT_TIMEOUT_MS } from '../chat-runner'
import { ChatStreamHub } from '../chat-stream-hub'
import type { UiMessageChunk } from '../ui-message-chunks'
import { CodexApiError, type StreamCodexResponseOpts } from '../codex-api'
import type { ChatMessage } from '../../lib/chat-store'

// ── SSE event fixtures ────────────────────────────────────────────────────────

const messageEvent = (text: string): unknown => ({
  type: 'response.output_item.done',
  item: { type: 'message', content: [{ type: 'output_text', text }] },
})

const functionCallEvent = (callId: string, command: string): unknown => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', call_id: callId, name: 'shell', arguments: JSON.stringify({ command }) },
})

const reasoningEvent = (text: string): unknown => ({
  type: 'response.output_item.done',
  item: { type: 'reasoning', summary: [{ type: 'summary_text', text }] },
})

const completedEvent = (input = 5, output = 3, cached = 0): unknown => ({
  type: 'response.completed',
  response: { usage: { input_tokens: input, output_tokens: output, input_tokens_details: { cached_tokens: cached } } },
})

// ── Parser tests ──────────────────────────────────────────────────────────────

describe('parseEventToSegments', () => {
  it('produces no segments for an unrecognised event type', () => {
    expect(parseEventToSegments({ type: 'response.created' })).toEqual([])
  })

  it('extracts a text segment from a completed assistant message item', () => {
    expect(parseEventToSegments(messageEvent('Hello!'))).toEqual([{ type: 'text', text: 'Hello!' }])
  })

  it('extracts a result segment from response.completed usage', () => {
    expect(parseEventToSegments(completedEvent(100, 50, 10))).toEqual([
      {
        type: 'result',
        durationMs: null,
        cost: null,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
      },
    ])
  })

  it('tolerates missing usage in response.completed', () => {
    const [seg] = parseEventToSegments({ type: 'response.completed', response: {} })
    expect(seg).toMatchObject({
      type: 'result',
      durationMs: null,
      cost: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
    })
  })

  it('emits tool_use with a derived display name for a function_call item', () => {
    const segs = parseEventToSegments(functionCallEvent('call-1', 'ls -la'))
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({
      type: 'tool_use',
      id: 'call-1',
      name: 'ls',
      input: { command: 'ls -la' },
    })
  })

  it('derives `mars <verb>` display names for mars commands', () => {
    const segs = parseEventToSegments(functionCallEvent('call-2', 'mars task add "x"'))
    expect(segs[0]).toMatchObject({ type: 'tool_use', name: 'mars task' })
  })

  it('emits a thinking segment from a reasoning summary', () => {
    expect(parseEventToSegments(reasoningEvent('pondering'))).toEqual([
      { type: 'thinking', thinking: 'pondering' },
    ])
  })

  it('emits nothing for a reasoning item with an empty summary', () => {
    expect(
      parseEventToSegments({ type: 'response.output_item.done', item: { type: 'reasoning', summary: [] } }),
    ).toEqual([])
  })
})

// ── Transcript replay tests ───────────────────────────────────────────────────

const msg = (role: 'user' | 'assistant', content: string, segments: unknown = null): ChatMessage => ({
  id: `m-${Math.random()}`,
  thread_id: 't1',
  role,
  content,
  segments,
  created_at: '',
})

describe('buildApiInput', () => {
  it('maps plain user/assistant messages to input/output text items', () => {
    const input = buildApiInput([msg('user', 'hello'), msg('assistant', 'hi there')])
    expect(input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
    ])
  })

  it('replays paired tool_use/tool_result segments as function_call items', () => {
    const segments = [
      { type: 'tool_use', id: 'call-1', name: 'ls', input: { command: 'ls' } },
      { type: 'tool_result', tool_use_id: 'call-1', content: { stdout: 'file\n', stderr: '', exitCode: 0 }, isError: false },
      { type: 'text', text: 'One file.' },
    ]
    const input = buildApiInput([msg('assistant', 'One file.', segments)])
    expect(input).toEqual([
      { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: 'ls' }), call_id: 'call-1' },
      { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ stdout: 'file\n', stderr: '', exitCode: 0 }) },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'One file.' }] },
    ])
  })

  it('drops a tool_use with no matching tool_result so calls never go unpaired', () => {
    const segments = [
      { type: 'tool_use', id: 'call-orphan', name: 'ls', input: { command: 'ls' } },
      { type: 'text', text: 'answer' },
    ]
    const input = buildApiInput([msg('assistant', 'answer', segments)])
    expect(input.every((i) => i.type === 'message')).toBe(true)
  })

  it('renders an alert segment as assistant text', () => {
    const alertSeg = {
      type: 'alert',
      kind: 'daemon-code-drift',
      entityId: 'daemon',
      priority: 'high',
      title: 'Daemon running stale code',
      whyNow: 'The running binary is 3 commits behind HEAD',
      actions: [{ op: 'restart', label: 'mars daemon restart', style: 'primary' }],
      resolved: false,
    }
    const input = buildApiInput([msg('assistant', 'Daemon running stale code', [alertSeg])])
    expect(input).toHaveLength(1)
    const item = input[0] as { type: string; content: Array<{ text: string }> }
    expect(item.type).toBe('message')
    expect(item.content[0].text).toContain('[Alert: daemon-code-drift] Daemon running stale code')
    expect(item.content[0].text).toContain('The running binary is 3 commits behind HEAD')
    expect(item.content[0].text).toContain('mars daemon restart')
  })

  it('skips thinking/result/error segments and empty messages', () => {
    const segments = [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'result', durationMs: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cost: null },
      { type: 'error', message: 'boom' },
    ]
    expect(buildApiInput([msg('assistant', '', segments), msg('user', '   ')])).toEqual([])
  })

  it('drops the oldest messages once the transcript exceeds the char budget', () => {
    const big = 'x'.repeat(70_000)
    const input = buildApiInput([msg('user', big), msg('assistant', big), msg('user', 'latest')])
    // 3 × 70k exceeds the 120k budget — the oldest message drops, newest survives.
    expect(input.length).toBe(2)
    const last = input.at(-1) as { content: Array<{ text: string }> }
    expect(last.content[0].text).toBe('latest')
  })
})

// ── Mock layer for state-machine tests ───────────────────────────────────────

// We need to hoist mock declarations before imports so vi.mock hoisting works.
vi.mock('../chat-system-prompt', () => ({
  resolveChatSystemPrompt: vi.fn().mockResolvedValue('TEST_SYSTEM_PROMPT'),
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

vi.mock('../../lib/git/claude', () => ({
  buildWorkerEnv: vi.fn(() => ({})),
  runSubprocessStreaming: vi.fn(),
}))

vi.mock('../../lib/chat-store', () => ({
  appendMessage: vi.fn().mockResolvedValue({ id: 'msg-1', content: '', role: 'user', thread_id: 't1', segments: null, created_at: '' }),
  getThread: vi.fn(),
  setThreadStatus: vi.fn().mockResolvedValue(undefined),
  updateThreadTitle: vi.fn().mockResolvedValue(undefined),
}))

// Dynamically import the mocked modules AFTER vi.mock declarations.
// Because vitest hoists vi.mock, these will receive the mocked implementations.
const codexApi = await import('../codex-api')
const { runSubprocessStreaming } = await import('../../lib/git/claude')
const chatStore = await import('../../lib/chat-store')

const mockStream = codexApi.streamCodexResponse as unknown as MockInstance<
  (opts: StreamCodexResponseOpts) => Promise<void>
>
const mockLoadAuth = codexApi.loadCodexAuth as unknown as MockInstance<() => Promise<unknown>>
const mockRefreshAuth = codexApi.refreshCodexAuth as unknown as MockInstance<(a: unknown) => Promise<unknown>>
const mockShell = runSubprocessStreaming as unknown as MockInstance<
  (
    cmd: string,
    args: readonly string[],
    cwd: string,
    onLine?: unknown,
    signal?: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
>

const AUTH = { accessToken: 'tok', accountId: 'acc', refreshToken: 'ref' }

const threadFixture = {
  id: 't1', title: '', status: 'idle' as const, created_at: '', updated_at: '',
  origin: null, alert_item_id: null, alert_resolved: false, evaporated_at: null,
}

/** streamCodexResponse implementation that emits the given events and resolves. */
const streamEmitting = (...events: unknown[]) =>
  async (opts: StreamCodexResponseOpts): Promise<void> => {
    for (const ev of events) opts.onEvent(ev)
  }

/** streamCodexResponse implementation that rejects when the signal aborts. */
const streamHangingUntilAbort = (onStart?: (opts: StreamCodexResponseOpts) => void) =>
  (opts: StreamCodexResponseOpts): Promise<void> => {
    onStart?.(opts)
    return new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      )
    })
  }

describe('ChatRunner UIMessage-chunk streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadAuth.mockResolvedValue(AUTH)
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: { ...threadFixture },
      messages: [],
      feedbacks: new Map(),
    })
  })

  it('streams each assistant message item as a text-delta chunk', async () => {
    const hub = new ChatStreamHub()
    const chunks: UiMessageChunk[] = []
    hub.subscribe('t1', { onChunk: (sc) => chunks.push(sc.chunk), onEnd: () => {} })

    mockStream.mockImplementation(
      streamEmitting(messageEvent('Hello'), messageEvent(' world'), messageEvent('!'), completedEvent()),
    )

    const runner = new ChatRunner(hub)
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    // Opening chunks, then a text-delta per message item, then a terminal finish.
    expect(chunks[0]).toEqual({ type: 'start' })
    expect(chunks[1]).toEqual({ type: 'start-step' })
    const textDeltas = chunks
      .filter((c): c is Extract<UiMessageChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map((c) => c.delta)
    expect(textDeltas).toEqual(['Hello', ' world', '!'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' })
  })

  it('accumulated message items join correctly for DB persistence', async () => {
    mockStream.mockImplementation(
      streamEmitting(messageEvent('A'), messageEvent('B'), messageEvent('C'), completedEvent()),
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const calls = vi.mocked(chatStore.appendMessage).mock.calls
    const assistantCall = calls.find((c) => c[1] === 'assistant')
    expect(assistantCall![2]).toBe('ABC')
  })
})

describe('ChatRunner state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadAuth.mockResolvedValue(AUTH)
    mockStream.mockImplementation(streamEmitting(messageEvent('ok'), completedEvent()))
    mockShell.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: { ...threadFixture },
      messages: [],
      feedbacks: new Map(),
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
  })

  it('returns alreadyRunning=false when the thread is idle', async () => {
    // Make the API call hang indefinitely so we can inspect the running state.
    let release: () => void = () => {}
    mockStream.mockImplementation((opts) => {
      opts.onEvent(messageEvent('late'))
      return new Promise((resolve) => { release = () => resolve() })
    })
    const runner = new ChatRunner()
    const result = await runner.sendMessage('t1', 'hello', '/repo', undefined)
    expect(result.alreadyRunning).toBe(false)
    release()
  })

  it('returns alreadyRunning=true (409 signal) when a run is already active', async () => {
    let release: () => void = () => {}
    mockStream.mockImplementationOnce((opts) => {
      opts.onEvent(messageEvent('first'))
      return new Promise((resolve) => { release = () => resolve() })
    })

    const runner = new ChatRunner()
    const r1 = await runner.sendMessage('t1', 'first', '/repo', undefined)
    expect(r1.alreadyRunning).toBe(false)

    const r2 = await runner.sendMessage('t1', 'second', '/repo', undefined)
    expect(r2.alreadyRunning).toBe(true)

    release()
  })

  it('allows a new run after a previous run completes', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'first', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 10))

    const r2 = await runner.sendMessage('t1', 'second', '/repo', undefined)
    expect(r2.alreadyRunning).toBe(false)
    await new Promise((r) => setTimeout(r, 10))
  })

  it('stop() returns false when there is no active run', () => {
    const runner = new ChatRunner()
    expect(runner.stop('t1')).toBe(false)
  })

  it('stop() aborts the active run and returns true', async () => {
    let aborted = false
    mockStream.mockImplementation(streamHangingUntilAbort((opts) => {
      opts.signal.addEventListener('abort', () => { aborted = true })
    }))

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const stopped = runner.stop('t1')
    expect(stopped).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(aborted).toBe(true)
  })

  it('finalises with an error segment when the timeout fires', async () => {
    vi.useFakeTimers()
    mockStream.mockImplementation(streamHangingUntilAbort())

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'timeout test', '/repo', undefined)

    // Advance past the 10-minute timeout.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100)

    vi.useRealTimers()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const calls = vi.mocked(chatStore.appendMessage).mock.calls
    const assistantCall = calls.find((c) => c[1] === 'assistant')
    expect(assistantCall).toBeDefined()
    const segments = assistantCall![3] as unknown[]
    const hasError = (segments ?? []).some(
      (s) => (s as { type?: string }).type === 'error',
    )
    expect(hasError).toBe(true)
  })

  it('persists assistant message with accumulated text on success', async () => {
    mockStream.mockImplementation(
      streamEmitting(messageEvent('Hello '), messageEvent('world!'), completedEvent()),
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const calls = vi.mocked(chatStore.appendMessage).mock.calls
    const assistantCall = calls.find((c) => c[1] === 'assistant')
    expect(assistantCall![2]).toBe('Hello world!')
  })

  it('finalises with an error segment when the run produces no text', async () => {
    mockStream.mockImplementation(streamEmitting(completedEvent()))

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const assistantCall = vi.mocked(chatStore.appendMessage).mock.calls.find((c) => c[1] === 'assistant')
    const segments = assistantCall![3] as Array<{ type: string; message?: string }>
    const errSeg = segments.find((s) => s.type === 'error')
    expect(errSeg?.message).toMatch(/without a chat response/i)
  })

  it('auto-titles the thread from the first message when title is empty', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'A long message that should be truncated at sixty chars exactly', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    expect(vi.mocked(chatStore.updateThreadTitle)).toHaveBeenCalledWith(
      't1',
      'A long message that should be truncated at sixty chars exact',
    )
  })

  it('does not auto-title when thread already has messages', async () => {
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: { ...threadFixture },
      messages: [{ id: 'm1', thread_id: 't1', role: 'user', content: 'prior', segments: null, created_at: '' }],
      feedbacks: new Map(),
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'follow-up', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    expect(vi.mocked(chatStore.updateThreadTitle)).not.toHaveBeenCalled()
  })

  // ── Tool loop ─────────────────────────────────────────────────────────────

  it('executes a shell call and feeds the output back into the next request', async () => {
    mockStream
      .mockImplementationOnce(streamEmitting(functionCallEvent('call-1', 'echo hi'), completedEvent(10, 5)))
      .mockImplementationOnce(streamEmitting(messageEvent('It printed hi.'), completedEvent(20, 7)))
    mockShell.mockResolvedValue({ exitCode: 0, stdout: 'hi\n', stderr: '' })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'run echo', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    // The shell executor ran the command from the repo root.
    expect(mockShell).toHaveBeenCalledWith(
      'bash', ['-lc', 'echo hi'], '/repo', undefined, expect.anything(), expect.anything(),
    )

    // The second request replays the call and its output.
    const secondInput = mockStream.mock.calls[1][0].input
    expect(secondInput).toContainEqual(
      { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: 'echo hi' }), call_id: 'call-1' },
    )
    expect(secondInput).toContainEqual(
      { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ stdout: 'hi\n', stderr: '', exitCode: 0 }) },
    )

    // Persisted segments include tool_use, tool_result, final text, and ONE
    // aggregated result segment.
    const assistantCall = vi.mocked(chatStore.appendMessage).mock.calls.find((c) => c[1] === 'assistant')
    const segments = assistantCall![3] as Array<{ type: string }>
    expect(segments.map((s) => s.type)).toEqual(['tool_use', 'tool_result', 'text', 'result'])
    const result = segments.at(-1) as unknown as { inputTokens: number; outputTokens: number }
    expect(result.inputTokens).toBe(30)
    expect(result.outputTokens).toBe(12)
  })

  it('marks a failing shell call as an error tool_result', async () => {
    mockStream
      .mockImplementationOnce(streamEmitting(functionCallEvent('call-1', 'false'), completedEvent()))
      .mockImplementationOnce(streamEmitting(messageEvent('It failed.'), completedEvent()))
    mockShell.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'nope' })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'run false', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const assistantCall = vi.mocked(chatStore.appendMessage).mock.calls.find((c) => c[1] === 'assistant')
    const segments = assistantCall![3] as Array<{ type: string; isError?: boolean }>
    const toolResult = segments.find((s) => s.type === 'tool_result')
    expect(toolResult?.isError).toBe(true)
  })

  // ── Transcript replay ─────────────────────────────────────────────────────

  it('replays prior messages as conversation input plus the fresh user turn', async () => {
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: { ...threadFixture, title: 'Chat' },
      messages: [
        { id: 'm0', thread_id: 't1', role: 'user', content: 'hello', segments: [{ type: 'text', text: 'hello' }], created_at: '' },
        { id: 'm1', thread_id: 't1', role: 'assistant', content: 'hi there', segments: [{ type: 'text', text: 'hi there' }], created_at: '' },
      ],
      feedbacks: new Map(),
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'how are you?', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const input = mockStream.mock.calls[0][0].input
    expect(input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'how are you?' }] },
    ])
  })

  it('replays the alert card of an alert-origin thread on every turn', async () => {
    const alertSeg = {
      type: 'alert',
      kind: 'daemon-code-drift',
      entityId: 'daemon',
      priority: 'high',
      title: 'Daemon running stale code',
      whyNow: 'The running binary is 3 commits behind HEAD',
      actions: [{ op: 'restart', label: 'mars daemon restart', style: 'primary' as const }],
      resolved: false,
    }
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: { ...threadFixture, title: 'Alert', origin: 'alert', alert_item_id: 'item-1' },
      messages: [
        { id: 'm0', thread_id: 't1', role: 'assistant', content: 'Daemon running stale code', segments: [alertSeg], created_at: '' },
      ],
      feedbacks: new Map(),
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'explain this one, i dont understand', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const input = mockStream.mock.calls[0][0].input
    const first = input[0] as { content: Array<{ text: string }> }
    expect(first.content[0].text).toContain('[Alert: daemon-code-drift] Daemon running stale code')
    expect(first.content[0].text).toContain('The running binary is 3 commits behind HEAD')
    expect(first.content[0].text).toContain('mars daemon restart')
    const last = input.at(-1) as { content: Array<{ text: string }> }
    expect(last.content[0].text).toBe('explain this one, i dont understand')
  })

  it('sends the resolved system prompt as instructions', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    expect(mockStream.mock.calls[0][0].instructions).toBe('TEST_SYSTEM_PROMPT')
    expect(mockStream.mock.calls[0][0].model).toBe('gpt-5.5')
  })

  // ── Throttle / auth failure ───────────────────────────────────────────────

  it('sets thread status to throttled on rate-limit and schedules a retry', async () => {
    vi.useFakeTimers()
    mockStream.mockRejectedValue(new CodexApiError('rate-limit', 'Codex rate/usage limit reached.', 429))

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => process.nextTick(r))
    await new Promise((r) => process.nextTick(r))

    const statusCalls = vi.mocked(chatStore.setThreadStatus).mock.calls
    const throttledCall = statusCalls.find((c) => c[1] === 'throttled')
    expect(throttledCall).toBeDefined()
    vi.useRealTimers()
  })

  it('throttles (not errors) on auth failure after a failed refresh', async () => {
    vi.useFakeTimers()
    mockStream.mockRejectedValue(new CodexApiError('auth', 'Codex rejected the stored credentials.', 401))
    mockRefreshAuth.mockRejectedValue(new CodexApiError('auth', 'refresh rejected'))

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => process.nextTick(r))
    await new Promise((r) => process.nextTick(r))
    await new Promise((r) => process.nextTick(r))

    expect(runner.isAuthFailed()).toBe(true)
    const statusCalls = vi.mocked(chatStore.setThreadStatus).mock.calls
    expect(statusCalls.some((c) => c[1] === 'throttled')).toBe(true)
    // No assistant error message on first throttle.
    const assistantCalls = vi.mocked(chatStore.appendMessage).mock.calls.filter((c) => c[1] === 'assistant')
    expect(assistantCalls).toHaveLength(0)
    vi.useRealTimers()
  })

  it('silently refreshes the token once and succeeds on retry', async () => {
    const freshAuth = { ...AUTH, accessToken: 'tok2' }
    mockStream
      .mockRejectedValueOnce(new CodexApiError('auth', 'Codex rejected the stored credentials.', 401))
      .mockImplementationOnce(streamEmitting(messageEvent('Recovered.'), completedEvent()))
    mockRefreshAuth.mockResolvedValue(freshAuth)

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    expect(mockRefreshAuth).toHaveBeenCalledWith(AUTH)
    expect(mockStream.mock.calls[1][0].auth).toBe(freshAuth)
    expect(runner.isAuthFailed()).toBe(false)
    const assistantCall = vi.mocked(chatStore.appendMessage).mock.calls.find((c) => c[1] === 'assistant')
    expect(assistantCall![2]).toBe('Recovered.')
  })

  it('routes a missing auth.json (loadCodexAuth failure) to the auth-throttle path', async () => {
    vi.useFakeTimers()
    mockLoadAuth.mockRejectedValue(new CodexApiError('auth', 'Codex credentials not found — run `codex login`.'))

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => process.nextTick(r))
    await new Promise((r) => process.nextTick(r))

    expect(runner.isAuthFailed()).toBe(true)
    vi.useRealTimers()
  })

  it('notifies auth listeners when auth failure is detected', async () => {
    mockStream.mockRejectedValue(new CodexApiError('auth', 'rejected', 401))
    mockRefreshAuth.mockRejectedValue(new CodexApiError('auth', 'refresh rejected'))

    const runner = new ChatRunner()
    const events: boolean[] = []
    runner.onAuthStateChange((failed) => events.push(failed))
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 10))

    expect(events).toContain(true)
  })

  it('finalises with a user-safe error on an http failure', async () => {
    mockStream.mockRejectedValue(new CodexApiError('http', 'Codex request failed (HTTP 500).', 500))

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const assistantCall = vi.mocked(chatStore.appendMessage).mock.calls.find((c) => c[1] === 'assistant')
    const segments = assistantCall![3] as Array<{ type: string; message?: string }>
    const errSeg = segments.find((s) => s.type === 'error')
    expect(errSeg?.message).toContain('Codex could not complete this response')
    expect(errSeg?.message).not.toContain('500')
  })

  // ── Attachments ───────────────────────────────────────────────────────────

  it('injects image attachment path into the prompt sent to the API', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'describe this', '/repo', undefined, [
      { id: 'att-1', path: '/abs/path/photo.png', mimeType: 'image/png', name: 'photo.png', size: 1024 },
    ])
    await new Promise((r) => setTimeout(r, 20))

    const input = mockStream.mock.calls[0][0].input
    const last = input.at(-1) as { content: Array<{ text: string }> }
    expect(last.content[0].text).toContain('describe this')
    expect(last.content[0].text).toContain('/abs/path/photo.png')
  })

  it('persists attachment segments on the user message', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'show me', '/repo', undefined, [
      { id: 'att-3', path: '/abs/path/screen.png', mimeType: 'image/png', name: 'screen.png', size: 512 },
    ])
    await new Promise((r) => setTimeout(r, 20))

    const calls = vi.mocked(chatStore.appendMessage).mock.calls
    const userCall = calls.find((c) => c[1] === 'user')
    expect(userCall).toBeDefined()
    const segments = userCall![3] as unknown[]
    const attSeg = (segments ?? []).find((s) => (s as { type?: string }).type === 'attachment')
    expect(attSeg).toBeDefined()
    expect((attSeg as { path: string; kindHint: string }).path).toBe('/abs/path/screen.png')
    expect((attSeg as { path: string; kindHint: string }).kindHint).toBe('image')
  })

  // ── shutdownDrain ─────────────────────────────────────────────────────────

  it('CHAT_TIMEOUT_MS is exported and equals 10 minutes', () => {
    expect(CHAT_TIMEOUT_MS).toBe(10 * 60 * 1000)
  })

  it('shutdownDrain finalises an active run with the shutdown message when no text was accumulated', async () => {
    mockStream.mockImplementation(streamHangingUntilAbort())

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'restart the daemon', '/repo', undefined)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    await runner.shutdownDrain('Daemon is restarting.', CHAT_TIMEOUT_MS)

    const assistantCalls = vi.mocked(chatStore.appendMessage).mock.calls.filter((c) => c[1] === 'assistant')
    expect(assistantCalls.length).toBeGreaterThan(0)
    const lastCall = assistantCalls.at(-1)
    expect(lastCall?.[2]).toBe('Daemon is restarting.')
    expect(lastCall?.[2]).not.toBe('[no output]')
  })

  it('shutdownDrain preserves already-accumulated text and does not inject the message', async () => {
    mockStream.mockImplementation(
      streamHangingUntilAbort((opts) => opts.onEvent(messageEvent('Restarting the daemon now.'))),
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'restart', '/repo', undefined)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    await runner.shutdownDrain('Daemon is restarting.', CHAT_TIMEOUT_MS)

    const assistantCalls = vi.mocked(chatStore.appendMessage).mock.calls.filter((c) => c[1] === 'assistant')
    const lastCall = assistantCalls.at(-1)
    expect(lastCall?.[2]).toBe('Restarting the daemon now.')
  })

  it('shutdownDrain is a no-op when no runs are active', async () => {
    const runner = new ChatRunner()
    await expect(runner.shutdownDrain('msg', 1000)).resolves.toBeUndefined()
  })
})
