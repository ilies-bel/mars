/**
 * Unit tests for parseCreatedTaskIds — a pure parser that extracts Mars task
 * IDs from chat-thread messages.
 *
 * Tests verify observable behaviour: given a message list, which task IDs are
 * returned. No filesystem, network, or daemon access.
 */

import { describe, it, expect } from 'bun:test'
import { parseCreatedTaskIds } from './parseCreatedTaskIds'
import type { ChatMessage, ChatSegmentToolUse } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toolUse = (
  input: unknown,
  result: unknown,
): ChatSegmentToolUse => ({
  type: 'tool_use',
  toolName: 'Bash',
  input,
  result,
  isError: false,
  status: 'complete',
})

const assistantMsg = (segments: ChatMessage['segments']): ChatMessage => ({
  id: 'msg-1',
  threadId: 'thread-1',
  role: 'assistant',
  segments,
  createdAt: '2024-01-01T00:00:00.000Z',
  feedback: null,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseCreatedTaskIds – no messages', () => {
  it('returns empty array for empty message list', () => {
    expect(parseCreatedTaskIds([])).toEqual([])
  })
})

describe('parseCreatedTaskIds – non-tool segments', () => {
  it('returns empty array when messages contain only text segments', () => {
    const msg = assistantMsg([{ type: 'text', text: 'mars task add "foo"' }])
    expect(parseCreatedTaskIds([msg])).toEqual([])
  })

  it('returns empty array when messages contain only attachment segments', () => {
    const msg = assistantMsg([
      { type: 'attachment', path: 'a.png', mimeType: 'image/png', name: 'a.png' },
    ])
    expect(parseCreatedTaskIds([msg])).toEqual([])
  })
})

describe('parseCreatedTaskIds – tool_use without mars task add', () => {
  it('ignores tool_use whose input does not contain "mars task add"', () => {
    const msg = assistantMsg([toolUse('git log --oneline', 'mars-aabbccdd something')])
    expect(parseCreatedTaskIds([msg])).toEqual([])
  })

  it('ignores tool_use with task-id result but unrelated command', () => {
    const msg = assistantMsg([toolUse({ command: 'ls -la' }, 'mars-deadbeef')])
    expect(parseCreatedTaskIds([msg])).toEqual([])
  })
})

describe('parseCreatedTaskIds – successful extraction', () => {
  it('extracts a task id from a string result', () => {
    const msg = assistantMsg([
      toolUse('mars task add "implement feature"', 'Task queued: mars-abc12345\nStatus: queued'),
    ])
    expect(parseCreatedTaskIds([msg])).toEqual(['mars-abc12345'])
  })

  it('handles string input with mars task add', () => {
    const msg = assistantMsg([
      toolUse('mars task add "something"', 'mars-11223344 added'),
    ])
    expect(parseCreatedTaskIds([msg])).toEqual(['mars-11223344'])
  })

  it('handles object input whose JSON contains mars task add', () => {
    const msg = assistantMsg([
      toolUse(
        { command: 'mars task add "feature"', cwd: '/repo' },
        { output: 'mars-deadbeef added' },
      ),
    ])
    expect(parseCreatedTaskIds([msg])).toEqual(['mars-deadbeef'])
  })

  it('extracts multiple ids from multiple matching tool_use segments', () => {
    const msg = assistantMsg([
      toolUse('mars task add "task 1"', 'mars-aabbccdd queued'),
      toolUse('mars task add "task 2"', 'mars-11223344 queued'),
    ])
    expect(parseCreatedTaskIds([msg])).toEqual(['mars-aabbccdd', 'mars-11223344'])
  })

  it('extracts ids across multiple messages', () => {
    const msg1 = assistantMsg([toolUse('mars task add "first"', 'mars-aaaabbbb queued')])
    const msg2 = assistantMsg([toolUse('mars task add "second"', 'mars-ccccdddd queued')])
    expect(parseCreatedTaskIds([msg1, msg2])).toEqual(['mars-aaaabbbb', 'mars-ccccdddd'])
  })
})

describe('parseCreatedTaskIds – deduplication', () => {
  it('deduplicates the same task id appearing in multiple results', () => {
    const msg = assistantMsg([
      toolUse('mars task add "first"', 'mars-aabbccdd queued'),
      toolUse('mars task add "same"', 'mars-aabbccdd queued'),
    ])
    expect(parseCreatedTaskIds([msg])).toEqual(['mars-aabbccdd'])
  })

  it('preserves first-seen order when deduplicating', () => {
    const msg = assistantMsg([
      toolUse('mars task add "b"', 'mars-bbbbbbbb'),
      toolUse('mars task add "a"', 'mars-aaaaaaaa'),
      toolUse('mars task add "b again"', 'mars-bbbbbbbb'),
    ])
    expect(parseCreatedTaskIds([msg])).toEqual(['mars-bbbbbbbb', 'mars-aaaaaaaa'])
  })
})

describe('parseCreatedTaskIds – edge cases', () => {
  it('ignores ids shorter than 8 hex chars', () => {
    const msg = assistantMsg([toolUse('mars task add "x"', 'mars-abc123')])
    expect(parseCreatedTaskIds([msg])).toEqual([])
  })

  it('handles null/undefined result gracefully', () => {
    const msg = assistantMsg([toolUse('mars task add "x"', null)])
    expect(parseCreatedTaskIds([msg])).toEqual([])
  })

  it('handles undefined result gracefully', () => {
    const msg = assistantMsg([toolUse('mars task add "x"', undefined)])
    expect(parseCreatedTaskIds([msg])).toEqual([])
  })
})
