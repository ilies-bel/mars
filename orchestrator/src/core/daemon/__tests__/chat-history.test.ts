/**
 * Tests for chat-history.ts — the bounded history replayed on every turn.
 *
 * History size is the main driver of chat latency and quota burn on this lane
 * (the backend forbids `store: true`, so nothing is held server-side), so the
 * caps and the tool-summarisation rules are load-bearing, not cosmetic.
 */

import { describe, expect, it } from 'vitest'
import {
  buildProviderHistory,
  flattenMessageText,
  splitTrailingUserTurn,
} from '../chat-history'
import type { ChatMessage } from '../../lib/chat-store'

const msg = (
  role: 'user' | 'assistant',
  content: string,
  segments: unknown[] | null = null,
  id = Math.random().toString(36).slice(2),
): ChatMessage => ({ id, thread_id: 't1', role, content, segments, created_at: '' })

describe('flattenMessageText', () => {
  it('falls back to content when a row has no segments', () => {
    expect(flattenMessageText(msg('user', 'plain text'))).toBe('plain text')
  })

  it('joins text segments', () => {
    expect(flattenMessageText(msg('assistant', 'ignored', [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'world' },
    ]))).toBe('Hello world')
  })

  it('summarises a tool call by name and drops its output', () => {
    const flattened = flattenMessageText(msg('assistant', 'ignored', [
      { type: 'tool_use', name: 'mars task', input: { command: 'mars task list' } },
      { type: 'tool_result', tool_use_id: 'c1', content: { stdout: 'a'.repeat(5000) }, isError: false },
      { type: 'text', text: 'Two tasks.' },
    ]))
    expect(flattened).toBe('used tool mars task Two tasks.')
    expect(flattened).not.toContain('aaaa')
  })

  it('drops thinking and result segments', () => {
    expect(flattenMessageText(msg('assistant', 'ignored', [
      { type: 'thinking', thinking: 'long private reasoning' },
      { type: 'result', inputTokens: 10, outputTokens: 2 },
      { type: 'text', text: 'Done.' },
    ]))).toBe('Done.')
  })

  it('renders an alert segment as structured text', () => {
    const flattened = flattenMessageText(msg('assistant', 'ignored', [
      {
        type: 'alert',
        kind: 'daemon-code-drift',
        title: 'Daemon running stale code',
        whyNow: 'Binary is 3 commits behind',
        actions: [{ op: 'restart', label: 'mars daemon restart' }],
      },
    ]))
    expect(flattened).toContain('[Alert: daemon-code-drift] Daemon running stale code')
    expect(flattened).toContain('Why now: Binary is 3 commits behind')
    expect(flattened).toContain('Available actions: mars daemon restart')
  })
})

describe('buildProviderHistory', () => {
  it('returns turns in chronological order with role-correct content types', () => {
    expect(buildProviderHistory([
      msg('user', 'hi'),
      msg('assistant', 'hello'),
    ])).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
    ])
  })

  it('skips messages that flatten to nothing', () => {
    expect(buildProviderHistory([
      msg('assistant', '', [{ type: 'thinking', thinking: 'only reasoning' }]),
      msg('user', 'hi'),
    ])).toHaveLength(1)
  })

  it('keeps only the newest maxMessages', () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg('user', `m${i}`))
    const history = buildProviderHistory(messages, { maxMessages: 3 })
    expect(history.map((h) => h.content[0]!.text)).toEqual(['m7', 'm8', 'm9'])
  })

  it('drops the oldest turns first when the char cap is hit', () => {
    // Newest two fit in 25 chars; the oldest does not.
    const history = buildProviderHistory([
      msg('user', 'x'.repeat(20)),
      msg('assistant', 'y'.repeat(12)),
      msg('user', 'z'.repeat(12)),
    ], { maxChars: 25 })

    expect(history).toHaveLength(2)
    expect(history[0]!.content[0]!.text).toBe('y'.repeat(12))
    expect(history[1]!.content[0]!.text).toBe('z'.repeat(12))
  })

  it('returns an empty history for an empty thread', () => {
    expect(buildProviderHistory([])).toEqual([])
  })
})

describe('splitTrailingUserTurn', () => {
  it('splits a trailing user turn off and reports its text', () => {
    const { history, trailingUserText } = splitTrailingUserTurn([
      { role: 'user', content: [{ type: 'input_text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'pending' }] },
    ])
    expect(history).toHaveLength(2)
    expect(history.at(-1)!.role).toBe('assistant')
    expect(trailingUserText).toBe('pending')
  })

  it('reports null when the thread ends on an assistant turn', () => {
    const { history, trailingUserText } = splitTrailingUserTurn([
      { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
    ])
    expect(history).toHaveLength(2)
    expect(trailingUserText).toBeNull()
  })

  it('strips consecutive trailing user turns but reports the last one', () => {
    const { history, trailingUserText } = splitTrailingUserTurn([
      { role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'earlier' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'latest' }] },
    ])
    expect(history).toHaveLength(1)
    expect(trailingUserText).toBe('latest')
  })

  it('handles an empty history', () => {
    expect(splitTrailingUserTurn([])).toEqual({ history: [], trailingUserText: null })
  })
})
