/**
 * Tests for chat-runner.ts — the run state machine and the contract it hands to
 * the provider.
 *
 * The provider itself (`runCodexOAuthTurn`) is mocked here: its own SSE parsing,
 * tool loop and credential handling are covered in codex-oauth.test.ts, and
 * history construction in chat-history.test.ts. What matters at this level is
 * that the runner streams whatever the provider emits, persists it, and maps
 * each failure kind onto the right recovery branch.
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
import { ChatRunner } from '../chat-runner'
import { ChatStreamHub } from '../chat-stream-hub'
import type { UiMessageChunk } from '../ui-message-chunks'
import type { ChatSegment } from '../chat-runner'
import type { CodexOAuthResult, CodexOAuthTurnOptions } from '../codex-oauth'

vi.mock('../chat-system-prompt', () => ({
  resolveChatSystemPrompt: vi.fn().mockResolvedValue('TEST_SYSTEM_PROMPT'),
}))

vi.mock('../codex-oauth', () => ({
  runCodexOAuthTurn: vi.fn(),
}))

vi.mock('../../lib/chat-store', () => ({
  appendMessage: vi.fn().mockResolvedValue({ id: 'msg-1', content: '', role: 'user', thread_id: 't1', segments: null, created_at: '' }),
  getThread: vi.fn(),
  setThreadStatus: vi.fn().mockResolvedValue(undefined),
  updateThreadTitle: vi.fn().mockResolvedValue(undefined),
}))

const { runCodexOAuthTurn } = await import('../codex-oauth')
const chatStore = await import('../../lib/chat-store')

const mockTurn = runCodexOAuthTurn as unknown as MockInstance<
  (options: CodexOAuthTurnOptions) => Promise<CodexOAuthResult>
>

const OK: CodexOAuthResult = {
  ok: true,
  usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
}

/** A thread row with no history, for the common case. */
const thread = (overrides: Record<string, unknown> = {}) => ({
  thread: {
    id: 't1', session_id: null, title: '', status: 'idle' as const,
    created_at: '', updated_at: '', origin: null,
    alert_item_id: null, alert_resolved: false, context_seeded: false, evaporated_at: null,
    ...overrides,
  },
  messages: [] as never[],
  feedbacks: new Map(),
})

/** Resolve the provider having streamed `segments`, then succeeded. */
const respondWith = (...segments: ChatSegment[]): void => {
  mockTurn.mockImplementation(async (options) => {
    for (const seg of segments) options.onSegment(seg)
    return OK
  })
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))

const assistantCalls = () =>
  vi.mocked(chatStore.appendMessage).mock.calls.filter((c) => c[1] === 'assistant')

const errorSegmentOf = (call: unknown[] | undefined): { type: string; message: string } | undefined => {
  const segments = (call?.[3] ?? []) as Array<{ type: string; message: string }>
  return segments.find((s) => s.type === 'error')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(chatStore.getThread).mockResolvedValue(thread())
  respondWith({ type: 'text', text: 'ok' })
})

afterEach(() => {
  vi.clearAllTimers()
})

// ── Streaming ─────────────────────────────────────────────────────────────────

describe('ChatRunner UIMessage-chunk streaming', () => {
  it('streams provider text deltas as text-delta chunks in one text block', async () => {
    const hub = new ChatStreamHub()
    const chunks: UiMessageChunk[] = []
    hub.subscribe('t1', { onChunk: (sc) => chunks.push(sc.chunk), onEnd: () => {} })

    respondWith(
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    )

    const runner = new ChatRunner(hub)
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await tick()

    const deltas = chunks.filter((c) => c.type === 'text-delta')
    expect(deltas.map((d) => (d as { delta: string }).delta)).toEqual(['Hel', 'lo'])
    // A single text block, so the UI renders one paragraph rather than two.
    const starts = chunks.filter((c) => c.type === 'text-start')
    expect(starts).toHaveLength(1)
  })

  it('streams tool_use and tool_result through to tool chunks', async () => {
    const hub = new ChatStreamHub()
    const chunks: UiMessageChunk[] = []
    hub.subscribe('t1', { onChunk: (sc) => chunks.push(sc.chunk), onEnd: () => {} })

    respondWith(
      { type: 'tool_use', id: 'call-1', name: 'mars task', input: { command: 'mars task list', cwd: '/repo' } },
      { type: 'tool_result', tool_use_id: 'call-1', content: { stdout: 'none', stderr: '', exitCode: 0 }, isError: false },
      { type: 'text', text: 'No tasks.' },
    )

    const runner = new ChatRunner(hub)
    await runner.sendMessage('t1', 'any tasks?', '/repo', undefined)
    await tick()

    expect(chunks.some((c) => c.type === 'tool-input-available')).toBe(true)
    expect(chunks.some((c) => c.type === 'tool-output-available')).toBe(true)
  })

  it('joins streamed text deltas for DB persistence', async () => {
    respondWith(
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
      { type: 'text', text: 'C' },
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await tick()

    expect(assistantCalls().find((c) => c[1] === 'assistant')![2]).toBe('ABC')
  })

  it('emits a terminal result segment carrying provider usage', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await tick()

    const segments = (assistantCalls().at(-1)?.[3] ?? []) as Array<Record<string, unknown>>
    const result = segments.find((s) => s.type === 'result')
    expect(result).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cost: null })
    expect(typeof result!.durationMs).toBe('number')
  })
})

// ── Provider contract ─────────────────────────────────────────────────────────

describe('ChatRunner provider contract', () => {
  it('passes the resolved system prompt through unmodified as the cache prefix', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await tick()

    // Verbatim: prepending anything per-run here would miss the prefix cache.
    expect(mockTurn.mock.calls[0]![0].systemPrompt).toBe('TEST_SYSTEM_PROMPT')
  })

  it('sends the user message as the prompt and the repo root as the tool cwd', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'how many tasks?', '/repo', undefined)
    await tick()

    const options = mockTurn.mock.calls[0]![0]
    expect(options.prompt).toBe('how many tasks?')
    expect(options.cwd).toBe('/repo')
  })

  it('replays prior turns as structured history, excluding the current prompt', async () => {
    vi.mocked(chatStore.getThread).mockResolvedValue({
      ...thread({ title: 'Chat' }),
      messages: [
        { id: 'm0', thread_id: 't1', role: 'user' as const, content: 'hello', segments: [{ type: 'text', text: 'hello' }], created_at: '' },
        { id: 'm1', thread_id: 't1', role: 'assistant' as const, content: 'hi there', segments: [{ type: 'text', text: 'hi there' }], created_at: '' },
      ],
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'how are you?', '/repo', undefined)
    await tick()

    const { history, prompt } = mockTurn.mock.calls[0]![0]
    expect(history).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
    ])
    expect(prompt).toBe('how are you?')
  })

  it('carries alert context through history on an alert-origin thread', async () => {
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
      ...thread({ title: 'Alert', origin: 'alert', alert_item_id: 'item-1' }),
      messages: [
        { id: 'm0', thread_id: 't1', role: 'assistant' as const, content: 'Daemon running stale code', segments: [alertSeg], created_at: '' },
      ],
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'explain this one', '/repo', undefined)
    await tick()

    const replayed = mockTurn.mock.calls[0]![0].history
      .flatMap((item) => item.content.map((c) => c.text))
      .join('\n')
    expect(replayed).toContain('Daemon running stale code')
    expect(replayed).toContain('The running binary is 3 commits behind HEAD')
    expect(replayed).toContain('mars daemon restart')
  })

  it('does not replay a trailing user turn twice on a retry', async () => {
    // A throttle retry re-reads the thread, which by then contains the user
    // message persisted on the first attempt.
    vi.mocked(chatStore.getThread).mockResolvedValue({
      ...thread(),
      messages: [
        { id: 'm0', thread_id: 't1', role: 'user' as const, content: 'hi', segments: [{ type: 'text', text: 'hi' }], created_at: '' },
      ],
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await tick()

    const { history, prompt } = mockTurn.mock.calls[0]![0]
    expect(history).toEqual([])
    expect(prompt).toBe('hi')
  })

  it('falls back to the trailing user turn when re-queued with no prompt', async () => {
    vi.mocked(chatStore.getThread).mockResolvedValue({
      ...thread(),
      messages: [
        { id: 'm0', thread_id: 't1', role: 'user' as const, content: 'original question', segments: [{ type: 'text', text: 'original question' }], created_at: '' },
      ],
    })

    // clearAuthFailure re-queues parked threads with an empty content string.
    const runner = new ChatRunner()
    mockTurn.mockResolvedValue({ ok: false, kind: 'auth', message: 'unauthorized' })
    await runner.sendMessage('t1', '', '/repo', undefined)
    await tick()
    respondWith({ type: 'text', text: 'answer' })
    runner.clearAuthFailure('/repo', undefined)
    await tick()

    expect(mockTurn.mock.calls.at(-1)![0].prompt).toBe('original question')
  })
})

// ── State machine ─────────────────────────────────────────────────────────────

describe('ChatRunner state machine', () => {
  it('returns alreadyRunning=false when the thread is idle', async () => {
    let resolveRun: (r: CodexOAuthResult) => void = () => {}
    mockTurn.mockReturnValue(new Promise<CodexOAuthResult>((r) => { resolveRun = r }))

    const runner = new ChatRunner()
    expect((await runner.sendMessage('t1', 'hello', '/repo', undefined)).alreadyRunning).toBe(false)
    resolveRun(OK)
  })

  it('returns alreadyRunning=true (409 signal) when a run is already active', async () => {
    let resolveFirst: (r: CodexOAuthResult) => void = () => {}
    mockTurn.mockReturnValueOnce(new Promise<CodexOAuthResult>((r) => { resolveFirst = r }))

    const runner = new ChatRunner()
    expect((await runner.sendMessage('t1', 'first', '/repo', undefined)).alreadyRunning).toBe(false)
    expect((await runner.sendMessage('t1', 'second', '/repo', undefined)).alreadyRunning).toBe(true)
    resolveFirst(OK)
  })

  it('allows a new run after a previous run completes', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'first', '/repo', undefined)
    await tick(10)

    expect((await runner.sendMessage('t1', 'second', '/repo', undefined)).alreadyRunning).toBe(false)
    await tick(10)
  })

  it('stop() returns false when there is no active run', () => {
    expect(new ChatRunner().stop('t1')).toBe(false)
  })

  it('stop() aborts the active run and returns true', async () => {
    let aborted = false
    mockTurn.mockImplementation(
      (options) =>
        new Promise<CodexOAuthResult>((resolve) => {
          options.signal.addEventListener('abort', () => {
            aborted = true
            resolve(OK)
          })
        }),
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(runner.stop('t1')).toBe(true)
    await tick(10)
    expect(aborted).toBe(true)
  })

  it('finalises with an error segment when the timeout fires', async () => {
    vi.useFakeTimers()
    mockTurn.mockImplementation(
      (options) =>
        new Promise<CodexOAuthResult>((resolve) => {
          options.signal.addEventListener('abort', () => resolve(OK))
        }),
    )

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'timeout test', '/repo', undefined)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100)
    vi.useRealTimers()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(errorSegmentOf(assistantCalls().at(-1))).toBeDefined()
  })

  it('auto-titles the thread from the first message when title is empty', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'A long message that should be truncated at sixty chars exactly', '/repo', undefined)
    await tick()

    expect(vi.mocked(chatStore.updateThreadTitle)).toHaveBeenCalledWith(
      't1',
      'A long message that should be truncated at sixty chars exact',
    )
  })

  it('does not auto-title when thread already has messages', async () => {
    vi.mocked(chatStore.getThread).mockResolvedValue({
      ...thread(),
      messages: [{ id: 'm1', thread_id: 't1', role: 'user' as const, content: 'prior', segments: null, created_at: '' }],
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'follow-up', '/repo', undefined)
    await tick()

    expect(vi.mocked(chatStore.updateThreadTitle)).not.toHaveBeenCalled()
  })

  it('finalises with an error segment when the provider reports no text', async () => {
    respondWith() // succeeds but streams nothing

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await tick()

    expect(errorSegmentOf(assistantCalls().at(-1))?.message).toMatch(/without a chat response/i)
  })
})

// ── Failure-kind mapping ──────────────────────────────────────────────────────

describe('ChatRunner failure-kind mapping', () => {
  it('throttles and schedules a retry on rate-limit', async () => {
    vi.useFakeTimers()
    mockTurn.mockResolvedValue({ ok: false, kind: 'rate-limit', message: 'usage limit reached' })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => process.nextTick(r))

    expect(vi.mocked(chatStore.setThreadStatus).mock.calls.some((c) => c[1] === 'throttled')).toBe(true)
    vi.useRealTimers()
  })

  it('throttles on auth failure and never leaks the provider message', async () => {
    vi.useFakeTimers()
    mockTurn.mockResolvedValue({
      ok: false,
      kind: 'auth',
      message: 'authentication failed for token sk-private-value',
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => process.nextTick(r))
    await new Promise((r) => process.nextTick(r))

    expect(runner.isAuthFailed()).toBe(true)
    expect(vi.mocked(chatStore.setThreadStatus).mock.calls.some((c) => c[1] === 'throttled')).toBe(true)
    for (const call of assistantCalls()) {
      expect(String(call[2])).not.toContain('sk-private-value')
      expect(JSON.stringify(call[3])).not.toContain('sk-private-value')
    }
    vi.useRealTimers()
  })

  it('treats missing credentials as an auth failure so the re-auth banner shows', async () => {
    vi.useFakeTimers()
    mockTurn.mockResolvedValue({ ok: false, kind: 'no-token', message: 'No Codex credentials found.' })

    const runner = new ChatRunner()
    expect(runner.isAuthFailed()).toBe(false)
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => process.nextTick(r))
    await new Promise((r) => process.nextTick(r))

    expect(runner.isAuthFailed()).toBe(true)
    vi.useRealTimers()
  })

  it('notifies auth listeners when auth failure is detected', async () => {
    vi.useFakeTimers()
    mockTurn.mockResolvedValue({ ok: false, kind: 'auth', message: 'unauthorized' })

    const runner = new ChatRunner()
    const events: boolean[] = []
    runner.onAuthStateChange((failed) => events.push(failed))
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await new Promise((r) => process.nextTick(r))
    await new Promise((r) => process.nextTick(r))

    expect(events).toContain(true)
    vi.useRealTimers()
  })

  it('surfaces a fixed user-safe message on a generic provider failure', async () => {
    mockTurn.mockResolvedValue({
      ok: false,
      kind: 'generic',
      message: 'internal detail mentioning account d65d55b1 and the prompt text',
    })

    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'hi', '/repo', undefined)
    await tick()

    const err = errorSegmentOf(assistantCalls().at(-1))
    expect(err?.message).toBe(
      'Codex could not complete this response. Try again; if it continues, check the local Codex setup.',
    )
    expect(err?.message).not.toContain('d65d55b1')
  })
})

// ── Attachments ───────────────────────────────────────────────────────────────

describe('ChatRunner attachments', () => {
  it('injects image attachment guidance into the prompt', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'describe this', '/repo', undefined, [
      { id: 'att-1', path: '/abs/path/photo.png', mimeType: 'image/png', name: 'photo.png', size: 1024 },
    ])
    await tick()

    const prompt = mockTurn.mock.calls[0]![0].prompt
    expect(prompt).toContain('describe this')
    expect(prompt).toContain('The user attached image /abs/path/photo.png')
  })

  it('injects audio attachment guidance with ffmpeg hint', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'transcribe this', '/repo', undefined, [
      { id: 'att-2', path: '/abs/path/clip.mp3', mimeType: 'audio/mpeg', name: 'clip.mp3', size: 2048 },
    ])
    await tick()

    const prompt = mockTurn.mock.calls[0]![0].prompt
    expect(prompt).toContain('audio file /abs/path/clip.mp3')
    expect(prompt).toContain('ffmpeg')
  })

  it('persists attachment segments on the user message', async () => {
    const runner = new ChatRunner()
    await runner.sendMessage('t1', 'show me', '/repo', undefined, [
      { id: 'att-3', path: '/abs/path/screen.png', mimeType: 'image/png', name: 'screen.png', size: 512 },
    ])
    await tick()

    const userCall = vi.mocked(chatStore.appendMessage).mock.calls.find((c) => c[1] === 'user')
    const segments = (userCall![3] ?? []) as Array<Record<string, unknown>>
    expect(segments.find((s) => s.type === 'attachment')).toMatchObject({
      path: '/abs/path/screen.png',
      kindHint: 'image',
    })
  })
})
