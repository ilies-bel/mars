/**
 * Unit tests for the live chat segment accumulation logic.
 *
 * `applyLiveEvent` is a pure reducer — tests exercise observable output
 * (the returned buffer snapshot) without touching any module state.
 *
 * Module-level store functions (pushLiveEvent / clearLiveBuffer / getLiveBuffer)
 * are tested in the "delta pipeline" section, which exercises the observable
 * behaviour of the full SSE→buffer flow without coupling to internal state.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { applyLiveEvent, pushLiveEvent, clearLiveBuffer, getLiveBuffer } from './chatBuffer'
import type { LiveBuffer, LiveEvent } from './chatBuffer'

const empty: LiveBuffer = {
  text: '',
  thinking: null,
  currentTool: null,
  toolCount: 0,
  error: null,
  done: false,
}

describe('applyLiveEvent — text', () => {
  it('appends text to an empty buffer', () => {
    const next = applyLiveEvent(empty, { type: 'text', text: 'hello' })
    expect(next.text).toBe('hello')
    expect(next.done).toBe(false)
  })

  it('concatenates successive text segments', () => {
    const s1 = applyLiveEvent(empty, { type: 'text', text: 'foo' })
    const s2 = applyLiveEvent(s1, { type: 'text', text: ' bar' })
    expect(s2.text).toBe('foo bar')
  })

  it('does not mutate the input buffer', () => {
    const before = { ...empty }
    applyLiveEvent(empty, { type: 'text', text: 'x' })
    expect(empty.text).toBe(before.text)
  })
})

describe('applyLiveEvent — thinking', () => {
  it('stores the thinking block text', () => {
    const next = applyLiveEvent(empty, { type: 'thinking', thinking: 'plan' })
    expect(next.thinking).toBe('plan')
  })

  it('overwrites the previous thinking block', () => {
    const s1 = applyLiveEvent(empty, { type: 'thinking', thinking: 'first' })
    const s2 = applyLiveEvent(s1, { type: 'thinking', thinking: 'second' })
    expect(s2.thinking).toBe('second')
  })
})

describe('applyLiveEvent — tool_use', () => {
  it('records the tool name and increments the count', () => {
    const next = applyLiveEvent(empty, {
      type: 'tool_use',
      id: 'tu1',
      name: 'Bash',
      input: { cmd: 'ls' },
    })
    expect(next.currentTool).toBe('Bash')
    expect(next.toolCount).toBe(1)
  })

  it('counts multiple tool_use events', () => {
    const bash: LiveEvent = { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }
    const read: LiveEvent = { type: 'tool_use', id: 'tu2', name: 'Read', input: {} }
    const s = [bash, read].reduce(applyLiveEvent, empty)
    expect(s.toolCount).toBe(2)
    expect(s.currentTool).toBe('Read')
  })
})

describe('applyLiveEvent — tool_result', () => {
  it('clears currentTool on tool_result', () => {
    const after = applyLiveEvent(
      { ...empty, currentTool: 'Bash', toolCount: 1 },
      { type: 'tool_result', tool_use_id: 'tu1', content: null, isError: false },
    )
    expect(after.currentTool).toBeNull()
    expect(after.toolCount).toBe(1) // count unchanged
  })
})

describe('applyLiveEvent — result', () => {
  it('marks the buffer done and clears currentTool', () => {
    const next = applyLiveEvent(
      { ...empty, currentTool: 'Bash', toolCount: 1, text: 'hi' },
      {
        type: 'result',
        durationMs: 1000,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cost: 0.001,
      },
    )
    expect(next.done).toBe(true)
    expect(next.currentTool).toBeNull()
    expect(next.text).toBe('hi')
  })
})

describe('applyLiveEvent — error', () => {
  it('stores the error message and marks done', () => {
    const next = applyLiveEvent(empty, { type: 'error', message: 'timeout' })
    expect(next.error).toBe('timeout')
    expect(next.done).toBe(true)
    expect(next.currentTool).toBeNull()
  })
})

describe('applyLiveEvent — full run sequence', () => {
  it('produces correct state after thinking → tool → text → result', () => {
    const events: LiveEvent[] = [
      { type: 'thinking', thinking: 'I will use Bash' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { cmd: 'ls' } },
      { type: 'tool_result', tool_use_id: 'tu1', content: 'file.ts', isError: false },
      { type: 'text', text: 'Done.' },
      { type: 'result', durationMs: 500, inputTokens: 80, outputTokens: 10, cacheReadTokens: 0, cost: 0.0005 },
    ]
    const final = events.reduce(applyLiveEvent, empty)
    expect(final.thinking).toBe('I will use Bash')
    expect(final.toolCount).toBe(1)
    expect(final.currentTool).toBeNull()
    expect(final.text).toBe('Done.')
    expect(final.error).toBeNull()
    expect(final.done).toBe(true)
  })
})

// ── Delta pipeline tests ──────────────────────────────────────────────────────
//
// These tests verify the observable behaviour of the full delta pipeline:
// daemon emits incremental text events → client reducer accumulates → done
// → buffer cleared. They exercise the module-level store functions rather
// than the pure reducer to confirm the end-to-end observable flow.

describe('delta pipeline — pushLiveEvent / clearLiveBuffer / getLiveBuffer', () => {
  // Isolate each test by using a unique thread id (avoids cross-test pollution
  // since the store is module-level).
  let threadId: string
  let counter = 0

  beforeEach(() => {
    counter += 1
    threadId = `test-thread-${counter}`
  })

  it('creates a buffer on the first push and returns null when none exists', () => {
    expect(getLiveBuffer(threadId)).toBeNull()
    pushLiveEvent(threadId, { type: 'text', text: 'hi' })
    expect(getLiveBuffer(threadId)).not.toBeNull()
    clearLiveBuffer(threadId)
    expect(getLiveBuffer(threadId)).toBeNull()
  })

  it('builds text incrementally from a sequence of delta events', () => {
    pushLiveEvent(threadId, { type: 'text', text: 'Hello' })
    expect(getLiveBuffer(threadId)?.text).toBe('Hello')
    pushLiveEvent(threadId, { type: 'text', text: ' world' })
    expect(getLiveBuffer(threadId)?.text).toBe('Hello world')
    pushLiveEvent(threadId, { type: 'text', text: '!' })
    expect(getLiveBuffer(threadId)?.text).toBe('Hello world!')
    clearLiveBuffer(threadId)
  })

  it('marks the buffer done and preserves accumulated text when result arrives', () => {
    pushLiveEvent(threadId, { type: 'text', text: 'The answer is 42' })
    pushLiveEvent(threadId, {
      type: 'result',
      durationMs: 800,
      inputTokens: 30,
      outputTokens: 5,
      cacheReadTokens: 0,
      cost: 0.0003,
    })
    const buf = getLiveBuffer(threadId)
    expect(buf?.done).toBe(true)
    expect(buf?.text).toBe('The answer is 42')
    clearLiveBuffer(threadId)
  })

  it('marks done and records error message when error event arrives', () => {
    pushLiveEvent(threadId, { type: 'error', message: 'Run timed out' })
    const buf = getLiveBuffer(threadId)
    expect(buf?.done).toBe(true)
    expect(buf?.error).toBe('Run timed out')
    clearLiveBuffer(threadId)
  })

  it('clears currentTool when tool_result follows tool_use', () => {
    pushLiveEvent(threadId, { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} })
    expect(getLiveBuffer(threadId)?.currentTool).toBe('Bash')
    pushLiveEvent(threadId, { type: 'tool_result', tool_use_id: 'tu1', content: 'ok', isError: false })
    expect(getLiveBuffer(threadId)?.currentTool).toBeNull()
    clearLiveBuffer(threadId)
  })
})
