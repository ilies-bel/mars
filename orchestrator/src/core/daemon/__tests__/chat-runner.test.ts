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
import { parseEventToSegments, ChatRunner } from '../chat-runner'
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
    thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false },
    messages: [],
  }),
  setThreadStatus: vi.fn().mockResolvedValue(undefined),
  setThreadSession: vi.fn().mockResolvedValue(undefined),
  updateThreadTitle: vi.fn().mockResolvedValue(undefined),
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
      thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false },
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
      thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false },
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
      thread: { id: 't1', session_id: null, title: '', status: 'idle', created_at: '', updated_at: '', origin: null, alert_item_id: null, alert_resolved: false },
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
})
