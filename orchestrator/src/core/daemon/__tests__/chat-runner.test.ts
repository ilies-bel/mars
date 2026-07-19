/**
 * Tests for chat-runner.ts — stream-json parser and run state machine.
 *
 * Parser tests: pure unit tests over `parseEventToSegments` fed with
 * synthetic ClaudeEvent fixtures.
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
import { parseEventToSegments, ChatRunner, TextDeltaTracker } from '../chat-runner'
import type { ClaudeEvent } from '../../lib/claude-stream'
import type { SubprocessLine, RunSubprocessResult } from '../../lib/git/claude'

// ── Parser tests ──────────────────────────────────────────────────────────────

describe('parseEventToSegments', () => {
  it('produces no segments for an unrecognised event type', () => {
    const event: ClaudeEvent = { type: 'system_init', session_id: 'abc' }
    expect(parseEventToSegments(event)).toEqual([])
  })

  it('extracts a text segment from an assistant event', () => {
    const event: ClaudeEvent = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello!' }] },
    }
    expect(parseEventToSegments(event)).toEqual([{ type: 'text', text: 'Hello!' }])
  })

  it('extracts a thinking segment from an assistant event', () => {
    const event: ClaudeEvent = {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'Let me think...' }] },
    }
    expect(parseEventToSegments(event)).toEqual([
      { type: 'thinking', thinking: 'Let me think...' },
    ])
  })

  it('extracts a tool_use segment from an assistant event', () => {
    const event: ClaudeEvent = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
    }
    expect(parseEventToSegments(event)).toEqual([
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'Bash',
        input: { command: 'ls' },
      },
    ])
  })

  it('extracts multiple segments from a single assistant event', () => {
    const event: ClaudeEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Thinking...' },
          { type: 'text', text: 'Done.' },
        ],
      },
    }
    const segs = parseEventToSegments(event)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ type: 'thinking', thinking: 'Thinking...' })
    expect(segs[1]).toEqual({ type: 'text', text: 'Done.' })
  })

  it('extracts a tool_result segment from a user event', () => {
    const event: ClaudeEvent = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'file.txt',
            is_error: false,
          },
        ],
      },
    }
    expect(parseEventToSegments(event)).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: 'file.txt',
        isError: false,
      },
    ])
  })

  it('marks tool_result.isError true when is_error is true', () => {
    const event: ClaudeEvent = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_2',
            content: 'ENOENT',
            is_error: true,
          },
        ],
      },
    }
    const [seg] = parseEventToSegments(event)
    expect(seg).toMatchObject({ type: 'tool_result', isError: true })
  })

  it('extracts a result segment with usage and cost', () => {
    const event: ClaudeEvent = {
      type: 'result',
      duration_ms: 1234,
      cost_usd: 0.005,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
      },
    }
    expect(parseEventToSegments(event)).toEqual([
      {
        type: 'result',
        durationMs: 1234,
        cost: 0.005,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
      },
    ])
  })

  it('tolerates missing fields in result event', () => {
    const event: ClaudeEvent = { type: 'result' }
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

  it('ignores non-tool_result blocks in user events', () => {
    const event: ClaudeEvent = {
      type: 'user',
      message: { content: [{ type: 'text', text: 'nope' }] },
    }
    expect(parseEventToSegments(event)).toEqual([])
  })

  it('ignores blocks with missing text in assistant events', () => {
    const event: ClaudeEvent = {
      type: 'assistant',
      message: { content: [{ type: 'text' }] },
    }
    expect(parseEventToSegments(event)).toEqual([])
  })
})

// ── TextDeltaTracker tests ────────────────────────────────────────────────────

describe('TextDeltaTracker', () => {
  it('returns the full text on the first call (nothing emitted yet)', () => {
    const t = new TextDeltaTracker()
    expect(t.next('Hello')).toBe('Hello')
  })

  it('returns only the new suffix when events are cumulative (each repeats all prior text)', () => {
    const t = new TextDeltaTracker()
    expect(t.next('Hello')).toBe('Hello')
    expect(t.next('Hello world')).toBe(' world')
    expect(t.next('Hello world!')).toBe('!')
  })

  it('returns the full text of each event when events are already incremental deltas', () => {
    const t = new TextDeltaTracker()
    expect(t.next('Hello')).toBe('Hello')
    expect(t.next(' world')).toBe(' world')
    expect(t.next('!')).toBe('!')
  })

  it('returns empty string when text is unchanged (duplicate event)', () => {
    const t = new TextDeltaTracker()
    t.next('Hello')
    expect(t.next('Hello')).toBe('')
  })

  it('handles a mix of empty and non-empty events without emitting empty deltas', () => {
    const t = new TextDeltaTracker()
    expect(t.next('')).toBe('')
    expect(t.next('A')).toBe('A')
    expect(t.next('A')).toBe('')
    expect(t.next('AB')).toBe('B')
  })
})

// ── Delta emission integration tests ─────────────────────────────────────────
//
// These tests drive ChatRunner with a mock subprocess that emits cumulative
// assistant events, then assert that the ViewStreamHub received incremental
// delta broadcasts — not the raw cumulative text.

describe('ChatRunner delta emission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false },
      messages: [],
    })
  })

  it('emits incremental text delta events when the CLI sends cumulative assistant messages', async () => {
    const broadcasts: unknown[] = []
    const mockHub = {
      broadcastData: (_ch: string, data: unknown) => { broadcasts.push(data) },
      broadcast: vi.fn(),
    }

    // Simulate the claude CLI emitting cumulative text: each assistant event
    // has the full text accumulated so far.
    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        onLine: ((l: SubprocessLine) => void) | undefined,
      ) => {
        if (onLine) {
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }) })
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } }) })
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world!' }] } }) })
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'result', duration_ms: 100, cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0 } }) })
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )

    const runner = new ChatRunner()
    // Cast to satisfy the typed hub dependency (we only need broadcastData).
    await runner.sendMessage('t1', 'hi', '/repo', mockHub as never)
    await new Promise((r) => setTimeout(r, 20))

    // Filter to text delta SSE events only.
    const textBroadcasts = (broadcasts as Array<{ threadId: string; event: { type: string; text?: string } }>)
      .filter((b) => b.event.type === 'text')
      .map((b) => b.event.text)

    // Should receive 3 incremental deltas, not 3 cumulative texts.
    expect(textBroadcasts).toEqual(['Hello', ' world', '!'])
  })

  it('emits a single text event when the CLI sends one final assistant message', async () => {
    const broadcasts: unknown[] = []
    const mockHub = {
      broadcastData: (_ch: string, data: unknown) => { broadcasts.push(data) },
      broadcast: vi.fn(),
    }

    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        onLine: ((l: SubprocessLine) => void) | undefined,
      ) => {
        if (onLine) {
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Complete response.' }] } }) })
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', mockHub as never)
    await new Promise((r) => setTimeout(r, 20))

    const textBroadcasts = (broadcasts as Array<{ threadId: string; event: { type: string; text?: string } }>)
      .filter((b) => b.event.type === 'text')
      .map((b) => b.event.text)

    expect(textBroadcasts).toEqual(['Complete response.'])
  })

  it('accumulated text segments join correctly for DB persistence after cumulative events', async () => {
    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        onLine: ((l: SubprocessLine) => void) | undefined,
      ) => {
        if (onLine) {
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }) })
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'AB' }] } }) })
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ABC' }] } }) })
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const calls = vi.mocked(chatStore.appendMessage).mock.calls
    const assistantCall = calls.find((c) => c[1] === 'assistant')
    // Concatenation of deltas ('A' + 'B' + 'C') should equal 'ABC'
    expect(assistantCall![2]).toBe('ABC')
  })
})

// ── State-machine tests ───────────────────────────────────────────────────────
//
// These tests mock the subprocess layer (runSubprocessStreaming) and the
// chat-store so the runner logic can be exercised without a real claude
// binary or SQLite database.

// We need to hoist mock declarations before imports so vi.mock hoisting works.
vi.mock('../../lib/git/claude', () => ({
  resolveClaudeBin: vi.fn(() => '/usr/bin/claude'),
  buildWorkerEnv: vi.fn(() => ({})),
  toClaudeSessionId: vi.fn((id: string) => id),
  runSubprocessStreaming: vi.fn(),
}))

vi.mock('../../lib/chat-store', () => ({
  appendMessage: vi.fn().mockResolvedValue({ id: 'msg-1', content: '', role: 'user', thread_id: 't1', segments: null, created_at: '' }),
  getThread: vi.fn().mockResolvedValue({
    thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false, context_seeded: false },
    messages: [],
  }),
  setThreadStatus: vi.fn().mockResolvedValue(undefined),
  setThreadSession: vi.fn().mockResolvedValue(undefined),
  updateThreadTitle: vi.fn().mockResolvedValue(undefined),
  markContextSeeded: vi.fn().mockResolvedValue(undefined),
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
      thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false, context_seeded: false },
      messages: [],
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
    // Simulate a run that emits two text segments.
    mockRunSubprocessStreaming.mockImplementation(
      async (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        onLine: ((l: SubprocessLine) => void) | undefined,
      ) => {
        if (onLine) {
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' }] } }) })
          onLine({ stream: 'stdout', line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'world!' }] } }) })
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
      thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false, context_seeded: false },
      messages: [],
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
      thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false, context_seeded: false },
      messages: [{ id: 'm1', thread_id: 't1', role: 'user', content: 'prior', segments: null, created_at: '' }],
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'follow-up', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    expect(vi.mocked(chatStore.updateThreadTitle)).not.toHaveBeenCalled()
  })

  it('finalises with error segment on non-zero exit code', async () => {
    mockRunSubprocessStreaming.mockResolvedValue({ exitCode: 127, stdout: '', stderr: 'command not found: claude' })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const calls = vi.mocked(chatStore.appendMessage).mock.calls
    const assistantCall = calls.find((c) => c[1] === 'assistant')
    const segments = assistantCall![3] as unknown[]
    const errSeg = (segments ?? []).find((s) => (s as { type?: string }).type === 'error')
    expect(errSeg).toBeDefined()
    expect((errSeg as { message: string }).message).toContain('command not found')
  })

  it('saves detected session_id from stream to the thread', async () => {
    // Emit a line with session_id
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
            line: JSON.stringify({ type: 'system_init', session_id: 'sess-abc-123' }),
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
        alert_item_id: 'item-1', alert_resolved: false, context_seeded: false,
      },
      messages: [
        {
          id: 'm0', thread_id: 't1', role: 'assistant' as const,
          content: 'Daemon running stale code',
          segments: [alertSeg], created_at: '',
        },
      ],
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'explain this one, i dont understand', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const subArgs = mockRunSubprocessStreaming.mock.calls[0][1] as string[]
    // buildChatArgs produces: ['-p', <content>, '--output-format', ...]
    const prompt = subArgs[1]
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
        alert_item_id: 'item-1', alert_resolved: false, context_seeded: true,
      },
      messages: [
        {
          id: 'm0', thread_id: 't1', role: 'assistant' as const,
          content: 'prior', segments: [], created_at: '',
        },
      ],
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'follow-up question', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const subArgs = mockRunSubprocessStreaming.mock.calls[0][1] as string[]
    const prompt = subArgs[1]
    expect(prompt).not.toContain('<thread_context>')
    expect(prompt).toBe('follow-up question')
    expect(vi.mocked(chatStore.markContextSeeded)).not.toHaveBeenCalled()
  })

  it('includes prior messages but no alert block on first run of a non-alert thread', async () => {
    vi.mocked(chatStore.getThread).mockResolvedValue({
      thread: {
        id: 't1', session_id: null, title: 'Chat', status: 'idle',
        created_at: '', updated_at: '', origin: null,
        alert_item_id: null, alert_resolved: false, context_seeded: false,
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
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'how are you?', '/repo', undefined)
    await new Promise((r) => setTimeout(r, 20))

    const subArgs = mockRunSubprocessStreaming.mock.calls[0][1] as string[]
    const prompt = subArgs[1]
    expect(prompt).toContain('<thread_context>')
    expect(prompt).not.toContain('[Alert:')
    expect(prompt).toContain('[user] hello')
    expect(prompt).toContain('[assistant] hi there')
    expect(prompt).toContain('how are you?')
    expect(vi.mocked(chatStore.markContextSeeded)).toHaveBeenCalledWith('t1')
  })
})
