/**
 * Tests for chat-runner.ts — stream-json parser and run state machine.
 *
 * Parser tests: pure unit tests over `parseEventToSegments` fed with
 * synthetic Codex JSONL fixtures.
 *
 * State machine tests: drive the `ChatRunner` class with a mocked
 * subprocess layer to assert 409 on concurrent runs, stop finalisation,
 * and timeout finalisation.
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
import { parseEventToSegments, ChatRunner, buildChatArgs, CHAT_TIMEOUT_MS } from '../chat-runner'
import { ChatStreamHub } from '../chat-stream-hub'
import type { UiMessageChunk } from '../ui-message-chunks'
import type { SubprocessLine, RunSubprocessResult } from '../../lib/git/claude'

// ── Parser tests ──────────────────────────────────────────────────────────────

describe('parseEventToSegments', () => {
  it('produces no segments for an unrecognised event type', () => {
    expect(parseEventToSegments({ type: 'turn.started' })).toEqual([])
  })

  it('extracts a text segment from a completed Codex agent message', () => {
    const event = { type: 'item.completed', item: { type: 'agent_message', text: 'Hello!' } }
    expect(parseEventToSegments(event)).toEqual([{ type: 'text', text: 'Hello!' }])
  })

  it('extracts a result segment from Codex turn usage', () => {
    const event = { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 } }
    expect(parseEventToSegments(event)).toEqual([
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

  it('tolerates missing usage in a completed turn', () => {
    const event = { type: 'turn.completed' }
    const [seg] = parseEventToSegments(event)
    expect(seg).toMatchObject({
      type: 'result',
      durationMs: null,
      cost: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
    })
  })

  it('emits tool_use for a command_execution item', () => {
    const event = { type: 'item.completed', item: { type: 'command_execution', id: 'cmd-1', command: 'ls -la', cwd: '/repo' } }
    const segs = parseEventToSegments(event)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({
      type: 'tool_use',
      id: 'cmd-1',
      name: 'ls',
      input: { command: 'ls -la', cwd: '/repo' },
    })
  })

  it('emits tool_result with isError=false for command_execution_output with exit_code 0', () => {
    const event = {
      type: 'item.completed',
      item: { type: 'command_execution_output', tool_use_id: 'cmd-1', stdout: 'file.txt\n', stderr: '', exit_code: 0 },
    }
    const segs = parseEventToSegments(event)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'cmd-1',
      content: { stdout: 'file.txt\n', stderr: '', exitCode: 0 },
      isError: false,
    })
  })

  it('emits tool_result with isError=true for non-zero exit code in command_execution_output', () => {
    const event = {
      type: 'item.completed',
      item: { type: 'command_execution_output', tool_use_id: 'cmd-2', stdout: '', stderr: 'not found', exit_code: 127 },
    }
    const segs = parseEventToSegments(event)
    expect(segs).toHaveLength(1)
    expect(segs[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'cmd-2',
      content: { stdout: '', stderr: 'not found', exitCode: 127 },
      isError: true,
    })
  })
})

// ── UIMessage-chunk streaming integration tests ─────────────────────────────
//
// These tests drive ChatRunner with Codex JSONL events and assert that the
// injected ChatStreamHub receives the mapped UIMessageChunks (the daemon-native
// replacement for the old client-side `chat-delta` mapping). A subscriber
// attached before the run receives every chunk live (start → text-delta … →
// finish).

describe('ChatRunner UIMessage-chunk streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false, context_seeded: false, evaporated_at: null },
      messages: [],
      feedbacks: new Map(),
    })
  })

  it('streams each completed Codex agent message as a text-delta chunk', async () => {
    const hub = new ChatStreamHub()
    const chunks: UiMessageChunk[] = []
    hub.subscribe('t1', { onChunk: (sc) => chunks.push(sc.chunk), onEnd: () => {} })

    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        onLine: ((l: SubprocessLine) => void) | undefined,
      ) => {
        if (onLine) {
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello' } }) })
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ' world' } }) })
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '!' } }) })
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3, cached_input_tokens: 0 } }) })
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )

    const runner = new ChatRunner(hub)
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    // Opening chunks, then a text-delta per agent message, then a terminal finish.
    expect(chunks[0]).toEqual({ type: 'start' })
    expect(chunks[1]).toEqual({ type: 'start-step' })
    const textDeltas = chunks
      .filter((c): c is Extract<UiMessageChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map((c) => c.delta)
    expect(textDeltas).toEqual(['Hello', ' world', '!'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' })
  })

  it('streams a single text-delta when the CLI sends one final assistant message', async () => {
    const hub = new ChatStreamHub()
    const chunks: UiMessageChunk[] = []
    hub.subscribe('t1', { onChunk: (sc) => chunks.push(sc.chunk), onEnd: () => {} })

    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        onLine: ((l: SubprocessLine) => void) | undefined,
      ) => {
        if (onLine) {
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Complete response.' } }) })
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )

    const runner = new ChatRunner(hub)
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const textDeltas = chunks
      .filter((c): c is Extract<UiMessageChunk, { type: 'text-delta' }> => c.type === 'text-delta')
      .map((c) => c.delta)
    expect(textDeltas).toEqual(['Complete response.'])
  })

  it('accumulated Codex messages join correctly for DB persistence', async () => {
    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        onLine: ((l: SubprocessLine) => void) | undefined,
      ) => {
        if (onLine) {
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'A' } }) })
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'B' } }) })
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'C' } }) })
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const calls = vi.mocked(chatStore.appendMessage).mock.calls
    const assistantCall = calls.find((c) => c[1] === 'assistant')
    expect(assistantCall![2]).toBe('ABC')
  })
})

// ── State-machine tests ───────────────────────────────────────────────────────
//
// These tests mock the subprocess layer (runSubprocessStreaming) and the
// chat-store so the runner logic can be exercised without a real Codex CLI
// binary or SQLite database.

// We need to hoist mock declarations before imports so vi.mock hoisting works.
vi.mock('../chat-system-prompt', () => ({
  resolveChatSystemPrompt: vi.fn().mockResolvedValue('TEST_SYSTEM_PROMPT'),
}))

vi.mock('../../lib/git/claude', () => ({
  buildWorkerEnv: vi.fn(() => ({})),
  runSubprocessStreaming: vi.fn(),
}))

vi.mock('../../lib/chat-store', () => ({
  appendMessage: vi.fn().mockResolvedValue({ id: 'msg-1', content: '', role: 'user', thread_id: 't1', segments: null, created_at: '' }),
  getThread: vi.fn().mockResolvedValue({
    thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false, context_seeded: false, evaporated_at: null },
    messages: [],
    feedbacks: new Map(),
  }),
  setThreadStatus: vi.fn().mockResolvedValue(undefined),
  setThreadSession: vi.fn().mockResolvedValue(undefined),
  updateThreadTitle: vi.fn().mockResolvedValue(undefined),
  markContextSeeded: vi.fn().mockResolvedValue(undefined),
  resetThreadSession: vi.fn().mockResolvedValue(undefined),
}))

// Dynamically import the mocked modules AFTER vi.mock declarations.
// Because vitest hoists vi.mock, these will receive the mocked implementations.
const { runSubprocessStreaming } = await import('../../lib/git/claude')
const chatStore = await import('../../lib/chat-store')

const mockRunSubprocessStreaming = runSubprocessStreaming as unknown as MockInstance<
  (
    cmd: string,
    args: readonly string[],
    cwd: string,
    onLine?: (line: SubprocessLine) => void,
    signal?: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ) => Promise<RunSubprocessResult>
>

describe('ChatRunner state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: subprocess completes immediately.
    mockRunSubprocessStreaming.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false, context_seeded: false, evaporated_at: null },
      messages: [],
      feedbacks: new Map(),
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
  })

  it('returns alreadyRunning=false when the thread is idle', async () => {
    // Make subprocess hang indefinitely so we can inspect the running state.
    let resolveRun: (r: RunSubprocessResult) => void = () => {}
    mockRunSubprocessStreaming.mockReturnValue(
      new Promise<RunSubprocessResult>((r) => { resolveRun = r }),
    )
    const runner = new ChatRunner()
    const result = await runner.sendMessage('t1', 'hello', '/repo', undefined)
    expect(result.alreadyRunning).toBe(false)
    // Resolve the subprocess so the runner can clean up.
    resolveRun({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('returns alreadyRunning=true (409 signal) when a run is already active', async () => {
    // Make first subprocess hang.
    let resolveFirst: (r: RunSubprocessResult) => void = () => {}
    mockRunSubprocessStreaming.mockReturnValueOnce(
      new Promise<RunSubprocessResult>((r) => { resolveFirst = r }),
    )

    const runner = new ChatRunner()
    // First call starts an active run.
    const r1 = await runner.sendMessage('t1', 'first', '/repo', undefined)
    expect(r1.alreadyRunning).toBe(false)

    // Second call while first is still running.
    const r2 = await runner.sendMessage('t1', 'second', '/repo', undefined)
    expect(r2.alreadyRunning).toBe(true)

    // Clean up.
    resolveFirst({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('allows a new run after a previous run completes', async () => {
    // First run resolves immediately.
    mockRunSubprocessStreaming.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'first', '/repo', undefined)
    // Drain microtasks so _run has a chance to call appendMessage etc. and finish.
    await new Promise((r) => setTimeout(r, 10))

    // Second run should be accepted.
    let resolveSecond: (r: RunSubprocessResult) => void = () => {}
    mockRunSubprocessStreaming.mockReturnValueOnce(
      new Promise<RunSubprocessResult>((r) => { resolveSecond = r }),
    )
    const r2 = await runner.sendMessage('t1', 'second', '/repo', undefined)
    expect(r2.alreadyRunning).toBe(false)
    resolveSecond({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('stop() returns false when there is no active run', () => {
    const runner = new ChatRunner()
    expect(runner.stop('t1')).toBe(false)
  })

  it('stop() aborts the active run and returns true', async () => {
    let aborted = false
    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        _onLine: ((l: SubprocessLine) => void) | undefined,
        signal: AbortSignal | undefined,
      ) => {
        return new Promise<RunSubprocessResult>((resolve) => {
          signal?.addEventListener('abort', () => {
            aborted = true
            resolve({ exitCode: 1, stdout: '', stderr: '' })
          })
        })
      },
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    // Let _run reach runSubprocessStreaming (drain a few microtask ticks).
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const stopped = runner.stop('t1')
    expect(stopped).toBe(true)
    // Give _run time to process the abort and call finalize.
    await new Promise((r) => setTimeout(r, 10))
    expect(aborted).toBe(true)
  })

  it('finalises with an error segment when the timeout fires', async () => {
    vi.useFakeTimers()

    // Subprocess hangs until aborted.
    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        _onLine: ((l: SubprocessLine) => void) | undefined,
        signal: AbortSignal | undefined,
      ) => {
        return new Promise<RunSubprocessResult>((resolve) => {
          signal?.addEventListener('abort', () =>
            resolve({ exitCode: 1, stdout: '', stderr: '' }),
          )
        })
      },
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'timeout test', '/repo', undefined)

    // Advance past the 10-minute timeout.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100)

    vi.useRealTimers()

    // Give finalise a tick to persist the message.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    // appendMessage should have been called with an error segment.
    const calls = vi.mocked(chatStore.appendMessage).mock.calls
    // User message + assistant finalise message
    const assistantCall = calls.find((c) => c[1] === 'assistant')
    expect(assistantCall).toBeDefined()
    const segments = assistantCall![3] as unknown[]
    const hasError = (segments ?? []).some(
      (s) => (s as { type?: string }).type === 'error',
    )
    expect(hasError).toBe(true)
  })

  it('persists assistant message with accumulated text on success', async () => {
    // Simulate Codex emitting two completed agent messages.
    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        onLine: ((l: SubprocessLine) => void) | undefined,
      ) => {
        if (onLine) {
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello ' } }) })
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'world!' } }) })
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const calls = vi.mocked(chatStore.appendMessage).mock.calls
    const assistantCall = calls.find((c) => c[1] === 'assistant')
    expect(assistantCall![2]).toBe('Hello world!')
  })

  it('auto-titles the thread from the first message when title is empty', async () => {
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false, context_seeded: false, evaporated_at: null },
      messages: [],
      feedbacks: new Map(),
    })

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
      thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false, context_seeded: false, evaporated_at: null },
      messages: [{ id: 'm1', thread_id: 't1', role: 'user', content: 'prior', segments: null, created_at: '' }],
      feedbacks: new Map(),
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'follow-up', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    expect(vi.mocked(chatStore.updateThreadTitle)).not.toHaveBeenCalled()
  })

  it('finalises with error segment on non-zero exit code', async () => {
    mockRunSubprocessStreaming.mockResolvedValue({ exitCode: 127, stdout: '', stderr: 'command not found: codex' })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const calls = vi.mocked(chatStore.appendMessage).mock.calls
    const assistantCall = calls.find((c) => c[1] === 'assistant')
    const segments = assistantCall![3] as unknown[]
    const errSeg = (segments ?? []).find((s) => (s as { type?: string }).type === 'error')
    expect(errSeg).toBeDefined()
    expect((errSeg as { message: string }).message).toContain('Codex is not available')
  })

  // ── Throttle / auth failure (slice 5) ─────────────────────────────────────

  it('sets thread status to throttled on rate-limit exit and schedules a retry', async () => {
    vi.useFakeTimers()
    mockRunSubprocessStreaming.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'rate limit exceeded — try again later',
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => process.nextTick(r))

    const statusCalls = vi.mocked(chatStore.setThreadStatus).mock.calls
    const throttledCall = statusCalls.find((c) => c[1] === 'throttled')
    expect(throttledCall).toBeDefined()
    vi.useRealTimers()
  })

  it('throttles (not errors) on authentication failure and does not expose private tokens', async () => {
    // Auth failures are throttled + retried instead of immediately surfacing an
    // error segment. This prevents noisy per-thread error messages when a single
    // OAuth token backs all threads.
    vi.useFakeTimers()
    mockRunSubprocessStreaming.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'authentication failed for token sk-private-value',
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    // Let the async _run complete
    await new Promise((r) => process.nextTick(r))
    await new Promise((r) => process.nextTick(r))

    // Auth failure → global flag set, throttled status (not an immediate error).
    expect(runner.isAuthFailed()).toBe(true)
    const statusCalls = vi.mocked(chatStore.setThreadStatus).mock.calls
    expect(statusCalls.some((c) => c[1] === 'throttled')).toBe(true)
    // No assistant message with a private token is emitted on first throttle.
    const assistantCalls = vi.mocked(chatStore.appendMessage).mock.calls.filter((c) => c[1] === 'assistant')
    for (const call of assistantCalls) {
      expect(String(call[2])).not.toContain('sk-private-value')
    }
    vi.useRealTimers()
  })

  it('sets codexAuthFailed=true when auth error is detected', async () => {
    mockRunSubprocessStreaming.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'authentication required — please sign in',
    })

    const runner = new ChatRunner()
    expect(runner.isAuthFailed()).toBe(false)
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => process.nextTick(r))
    await new Promise((r) => process.nextTick(r))

    expect(runner.isAuthFailed()).toBe(true)
  })

  it('notifies auth listeners when auth failure is detected', async () => {
    mockRunSubprocessStreaming.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'credential error: not authenticated',
    })

    const runner = new ChatRunner()
    const events: boolean[] = []
    runner.onAuthStateChange((failed) => events.push(failed))
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => process.nextTick(r))
    await new Promise((r) => process.nextTick(r))

    expect(events).toContain(true)
  })

  it('calls resetThreadSession and surfaces error segment when session is expired on both attempts', async () => {
    // Both attempts return session-expired — the runner surfaces an error
    // only after exhausting the single auto-retry.
    mockRunSubprocessStreaming.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'session not found — session has expired',
    })
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: { id: 't1', session_id: 'old-sess', title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false, context_seeded: true, evaporated_at: null },
      messages: [],
      feedbacks: new Map(),
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    // Give async _run chain time to complete (two subprocess calls in sequence).
    await new Promise((r) => setTimeout(r, 20))

    expect(vi.mocked(chatStore.resetThreadSession)).toHaveBeenCalledWith('t1')
    // After the auto-retry also fails, an error segment is surfaced.
    const assistantCalls = vi.mocked(chatStore.appendMessage).mock.calls.filter((c) => c[1] === 'assistant')
    const lastCall = assistantCalls.at(-1)
    const segments = (lastCall?.[3] ?? []) as Array<{ type: string; message?: string }>
    const errSeg = segments.find((s) => s.type === 'error')
    expect(errSeg).toBeDefined()
    expect(errSeg!.message).toMatch(/session expired/i)
  })

  it('auto-retries silently when session expires and succeeds on second attempt', async () => {
    // First attempt: session expired — runner resets session and retries.
    mockRunSubprocessStreaming.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'session not found — session has expired',
    })
    // Second attempt: Codex responds normally.
    mockRunSubprocessStreaming.mockImplementationOnce(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        onLine: ((l: SubprocessLine) => void) | undefined,
      ) => {
        if (onLine) {
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Retried OK' } }) })
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )
    // First getThread call: thread with expired session.
    vi.mocked(chatStore.getThread).mockResolvedValueOnce({
      thread: { id: 't1', session_id: 'old-sess', title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false, context_seeded: true, evaporated_at: null },
      messages: [],
      feedbacks: new Map(),
    })
    // Second getThread call (auto-retry): fresh session after resetThreadSession.
    vi.mocked(chatStore.getThread).mockResolvedValueOnce({
      thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false, context_seeded: false, evaporated_at: null },
      messages: [{ id: 'm0', thread_id: 't1', role: 'user' as const, content: 'hi', segments: null, created_at: '' }],
      feedbacks: new Map(),
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    // Session was cleared.
    expect(vi.mocked(chatStore.resetThreadSession)).toHaveBeenCalledWith('t1')
    // The retry succeeded — the final assistant message has text content,
    // not an error segment.
    const assistantCalls = vi.mocked(chatStore.appendMessage).mock.calls.filter((c) => c[1] === 'assistant')
    const lastCall = assistantCalls.at(-1)
    expect(lastCall?.[2]).toBe('Retried OK')
    const segments = (lastCall?.[3] ?? []) as Array<{ type: string }>
    expect(segments.some((s) => s.type === 'error')).toBe(false)
  })

  it('saves detected session_id from stream to the thread', async () => {
    // Codex emits its durable session id as thread.started.
    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        onLine: ((l: SubprocessLine) => void) | undefined,
      ) => {
        if (onLine) {
          onLine({
            stream: 'stdout',
            line: JSON.stringify({ type: 'thread.started', thread_id: 'sess-abc-123' }),
          })
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    expect(vi.mocked(chatStore.setThreadSession)).toHaveBeenCalledWith('t1', 'sess-abc-123')
  })

  // ── Context preamble tests ─────────────────────────────────────────────────
  //
  // Verify that the runner injects a <thread_context> block on the first run
  // of a thread (context_seeded=false) and skips it on subsequent turns
  // (context_seeded=true).

  it('prepends alert context preamble on the first run of an alert thread', async () => {
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
      thread: {
        id: 't1', session_id: null, title: 'Alert', status: 'idle',
        created_at: '', updated_at: '', origin: 'alert',
        alert_item_id: 'item-1', alert_resolved: false, context_seeded: false, evaporated_at: null,
      },
      messages: [
        {
          id: 'm0', thread_id: 't1', role: 'assistant' as const,
          content: 'Daemon running stale code',
          segments: [alertSeg], created_at: '',
        },
      ],
      feedbacks: new Map(),
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'explain this one, i dont understand', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const subArgs = mockRunSubprocessStreaming.mock.calls[0][1] as string[]
    const prompt = subArgs.at(-1)!
    expect(prompt).toContain('<thread_context>')
    expect(prompt).toContain('Daemon running stale code')
    expect(prompt).toContain('The running binary is 3 commits behind HEAD')
    expect(prompt).toContain('mars daemon restart')
    expect(prompt).toContain('explain this one, i dont understand')
    expect(prompt).toContain('</thread_context>')
    expect(vi.mocked(chatStore.markContextSeeded)).toHaveBeenCalledWith('t1')
  })

  it('does not prepend preamble on a subsequent turn (context_seeded=true)', async () => {
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: {
        id: 't1', session_id: 'sess-existing', title: 'Alert', status: 'idle',
        created_at: '', updated_at: '', origin: 'alert',
        alert_item_id: 'item-1', alert_resolved: false, context_seeded: true, evaporated_at: null,
      },
      messages: [
        {
          id: 'm0', thread_id: 't1', role: 'assistant' as const,
          content: 'prior', segments: [], created_at: '',
        },
      ],
      feedbacks: new Map(),
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'follow-up question', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const subArgs = mockRunSubprocessStreaming.mock.calls[0][1] as string[]
    const prompt = subArgs.at(-1)!
    expect(prompt).not.toContain('<thread_context>')
    expect(prompt).toBe('follow-up question')
    expect(vi.mocked(chatStore.markContextSeeded)).not.toHaveBeenCalled()
  })

  // ── System-prompt tests ────────────────────────────────────────────────────

  it('pins gpt-5.5 and high effort, embedding system instructions on a fresh run', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const args = mockRunSubprocessStreaming.mock.calls[0][1] as string[]
    expect(args).toContain('exec')
    expect(args).toContain('--json')
    expect(args).toContain('gpt-5.5')
    expect(args).toContain('model_reasoning_effort="high"')
    expect(args).toContain('--sandbox')
    expect(args.at(-1)).toContain('<system_instructions>\nTEST_SYSTEM_PROMPT')
  })

  it('resumes the persisted Codex session without repeating system instructions', async () => {
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: {
        id: 't1', session_id: 'existing-sess', title: 'title', status: 'idle',
        created_at: '', updated_at: '', origin: null,
        alert_item_id: null, alert_resolved: false, context_seeded: true, evaporated_at: null,
      },
      messages: [],
      feedbacks: new Map(),
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'follow-up', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const args = mockRunSubprocessStreaming.mock.calls[0][1] as string[]
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '--json'])
    expect(args).toContain('existing-sess')
    expect(args.at(-1)).toBe('follow-up')
    expect(args.at(-1)).not.toContain('system_instructions')
  })

  it('includes prior messages but no alert block on first run of a non-alert thread', async () => {
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: {
        id: 't1', session_id: null, title: 'Chat', status: 'idle',
        created_at: '', updated_at: '', origin: null,
        alert_item_id: null, alert_resolved: false, context_seeded: false, evaporated_at: null,
      },
      messages: [
        {
          id: 'm0', thread_id: 't1', role: 'user' as const,
          content: 'hello',
          segments: [{ type: 'text', text: 'hello' }], created_at: '',
        },
        {
          id: 'm1', thread_id: 't1', role: 'assistant' as const,
          content: 'hi there',
          segments: [{ type: 'text', text: 'hi there' }], created_at: '',
        },
      ],
      feedbacks: new Map(),
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'how are you?', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const subArgs = mockRunSubprocessStreaming.mock.calls[0][1] as string[]
    const prompt = subArgs.at(-1)!
    expect(prompt).toContain('<thread_context>')
    expect(prompt).not.toContain('[Alert:')
    expect(prompt).toContain('[user] hello')
    expect(prompt).toContain('[assistant] hi there')
    expect(prompt).toContain('how are you?')
    expect(vi.mocked(chatStore.markContextSeeded)).toHaveBeenCalledWith('t1')
  })

  // ── Network-access override tests ─────────────────────────────────────────
  //
  // The chat agent runs `mars` commands and queries the daemon/Postgres over
  // loopback. Codex's workspace-write sandbox denies loopback by default, so
  // we must pass `-c sandbox_workspace_write.network_access=true` on every
  // turn — both the first exec and resume branches.

  it('first-turn args include the network_access=true config override', () => {
    const args = buildChatArgs('hello', null, 'SYS_PROMPT')
    const idx = args.indexOf('-c')
    // There must be at least one `-c` flag followed by the network_access override.
    const networkAccessIdx = args.findIndex(
      (a, i) => i > 0 && args[i - 1] === '-c' && a === 'sandbox_workspace_write.network_access=true',
    )
    expect(idx).toBeGreaterThan(-1)
    expect(networkAccessIdx).toBeGreaterThan(-1)
  })

  it('resume-turn args include the network_access=true config override', () => {
    const args = buildChatArgs('follow-up', 'sess-abc', 'SYS_PROMPT')
    const networkAccessIdx = args.findIndex(
      (a, i) => i > 0 && args[i - 1] === '-c' && a === 'sandbox_workspace_write.network_access=true',
    )
    expect(networkAccessIdx).toBeGreaterThan(-1)
  })

  // ── Attachment tests ───────────────────────────────────────────────────────

  it('injects image attachment path into the prompt passed to Codex', async () => {
    let capturedArgs: readonly string[] = []
    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        args: readonly string[],
      ) => {
        capturedArgs = args
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'describe this', '/repo', undefined, [
      { id: 'att-1', path: '/abs/path/photo.png', mimeType: 'image/png', name: 'photo.png', size: 1024 },
    ])
    await new Promise((r) => setTimeout(r, 20))

    const prompt = capturedArgs.at(-1) as string
    expect(prompt).toContain('describe this')
    expect(prompt).toContain('---')
    expect(prompt).toContain('The user attached image /abs/path/photo.png — read it with the Read tool.')
  })

  it('injects audio attachment path into the prompt with ffmpeg guidance', async () => {
    let capturedArgs: readonly string[] = []
    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        args: readonly string[],
      ) => {
        capturedArgs = args
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'transcribe this', '/repo', undefined, [
      { id: 'att-2', path: '/abs/path/clip.mp3', mimeType: 'audio/mpeg', name: 'clip.mp3', size: 2048 },
    ])
    await new Promise((r) => setTimeout(r, 20))

    const prompt = capturedArgs.at(-1) as string
    expect(prompt).toContain('transcribe this')
    expect(prompt).toContain('audio file /abs/path/clip.mp3')
    expect(prompt).toContain('ffmpeg')
  })

  it('persists attachment segments on the user message', async () => {
    mockRunSubprocessStreaming.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })

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

  // ── shutdownDrain tests ───────────────────────────────────────────────────
  //
  // Verify that a restart requested while a chat run is active does not leave
  // the thread with "[no output]", and that the drain awaits finalisation
  // before returning.

  it('CHAT_TIMEOUT_MS is exported and equals 10 minutes', () => {
    expect(CHAT_TIMEOUT_MS).toBe(10 * 60 * 1000)
  })

  it('shutdownDrain finalises an active run with the shutdown message when no text was accumulated', async () => {
    // Subprocess hangs until the abort signal fires.
    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        _onLine: ((l: SubprocessLine) => void) | undefined,
        signal: AbortSignal | undefined,
      ) => {
        return new Promise<RunSubprocessResult>((resolve) => {
          signal?.addEventListener('abort', () =>
            resolve({ exitCode: 1, stdout: '', stderr: '' }),
          )
        })
      },
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'restart the daemon', '/repo', undefined)
    // Let _run advance past setup and block on the subprocess.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    // shutdownDrain aborts the subprocess and waits for finalize.
    await runner.shutdownDrain('Daemon is restarting.', CHAT_TIMEOUT_MS)

    // The thread must have been finalised with the shutdown message — NOT '[no output]'.
    const assistantCalls = vi.mocked(chatStore.appendMessage).mock.calls.filter((c) => c[1] === 'assistant')
    expect(assistantCalls.length).toBeGreaterThan(0)
    const lastCall = assistantCalls.at(-1)
    expect(lastCall?.[2]).toBe('Daemon is restarting.')
    expect(lastCall?.[2]).not.toBe('[no output]')
  })

  it('shutdownDrain preserves already-accumulated text and does not inject the message', async () => {
    // Subprocess emits a text segment first, then hangs until aborted.
    let capturedOnLine: ((l: SubprocessLine) => void) | undefined
    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        onLine: ((l: SubprocessLine) => void) | undefined,
        signal: AbortSignal | undefined,
      ) => {
        capturedOnLine = onLine
        return new Promise<RunSubprocessResult>((resolve) => {
          signal?.addEventListener('abort', () =>
            resolve({ exitCode: 1, stdout: '', stderr: '' }),
          )
        })
      },
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'restart', '/repo', undefined)
    // Let _run advance past setup and block on the subprocess.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    // Emit a text segment before the daemon shuts down.
    capturedOnLine?.({
      stream: 'stdout',
      line: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Restarting the daemon now.' } }),
    })

    await runner.shutdownDrain('Daemon is restarting.', CHAT_TIMEOUT_MS)

    const assistantCalls = vi.mocked(chatStore.appendMessage).mock.calls.filter((c) => c[1] === 'assistant')
    const lastCall = assistantCalls.at(-1)
    // The already-accumulated text must be preserved; shutdown message must not be injected.
    expect(lastCall?.[2]).toBe('Restarting the daemon now.')
  })

  it('shutdownDrain is a no-op when no runs are active', async () => {
    const runner = new ChatRunner()
    // No sendMessage call — nothing to drain.
    await expect(runner.shutdownDrain('msg', 1000)).resolves.toBeUndefined()
  })
})
