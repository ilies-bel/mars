/**
 * Tests for ChatPage segment-grouping and label helpers.
 *
 * Segment grouping (groupMessageSegments) and label formatting
 * (toolGroupLabel) are pure functions that describe observable
 * chat-rendering behaviour without requiring a DOM or React rendering.
 * These are the most important correctness properties for the
 * message-rendering pipeline.
 */

import { describe, it, expect } from 'bun:test'
import { groupMessageSegments, toolGroupLabel } from './ChatPage'
import type { ChatMessage } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMsg = (
  segments: ChatMessage['segments'],
  role: 'user' | 'assistant' = 'assistant',
): ChatMessage => ({
  id: 'msg-1',
  threadId: 'thread-1',
  role,
  segments,
  createdAt: new Date().toISOString(),
})

// ---------------------------------------------------------------------------
// groupMessageSegments
// ---------------------------------------------------------------------------

describe('groupMessageSegments', () => {
  it('passes a lone text segment through as-is', () => {
    const msg = makeMsg([{ type: 'text', text: 'hello' }])
    const out = groupMessageSegments(msg)
    expect(out).toEqual([{ kind: 'text', text: 'hello' }])
  })

  it('passes a lone thinking segment through as-is', () => {
    const msg = makeMsg([{ type: 'thinking', text: 'thinking...' }])
    const out = groupMessageSegments(msg)
    expect(out).toEqual([{ kind: 'thinking', text: 'thinking...' }])
  })

  it('collapses consecutive tool_use segments into a single tool_group', () => {
    const msg = makeMsg([
      { type: 'tool_use', toolName: 'Bash', input: { cmd: 'ls' }, status: 'complete', isError: false },
      { type: 'tool_use', toolName: 'Read', input: { path: '/foo' }, status: 'complete', isError: false },
    ])
    const out = groupMessageSegments(msg)
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('tool_group')
    const group = out[0] as { kind: 'tool_group'; tools: ChatMessage['segments'] }
    expect(group.tools).toHaveLength(2)
  })

  it('does not merge non-consecutive tool_use segments', () => {
    const msg = makeMsg([
      { type: 'tool_use', toolName: 'Bash', input: {}, status: 'complete', isError: false },
      { type: 'text', text: 'between' },
      { type: 'tool_use', toolName: 'Read', input: {}, status: 'complete', isError: false },
    ])
    const out = groupMessageSegments(msg)
    expect(out).toHaveLength(3)
    expect(out[0]!.kind).toBe('tool_group')
    expect(out[1]!.kind).toBe('text')
    expect(out[2]!.kind).toBe('tool_group')
  })

  it('handles a mixed message: thinking → tools → text', () => {
    const msg = makeMsg([
      { type: 'thinking', text: 'let me think' },
      { type: 'tool_use', toolName: 'Bash', input: {}, status: 'complete', isError: false },
      { type: 'tool_use', toolName: 'Bash', input: {}, status: 'complete', isError: false },
      { type: 'text', text: 'done' },
    ])
    const out = groupMessageSegments(msg)
    expect(out).toHaveLength(3)
    expect(out[0]!.kind).toBe('thinking')
    expect(out[1]!.kind).toBe('tool_group')
    expect(out[2]!.kind).toBe('text')
  })

  it('returns an empty array for a message with no segments', () => {
    const msg = makeMsg([])
    expect(groupMessageSegments(msg)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// toolGroupLabel
// ---------------------------------------------------------------------------

describe('toolGroupLabel', () => {
  it('labels a single tool without a count suffix', () => {
    const tools = [
      { type: 'tool_use' as const, toolName: 'Read', input: {}, status: 'complete' as const, isError: false },
    ]
    expect(toolGroupLabel(tools)).toBe('Used 1 tool — Read')
  })

  it('appends ×N for repeated tool names', () => {
    const tools = [
      { type: 'tool_use' as const, toolName: 'Bash', input: {}, status: 'complete' as const, isError: false },
      { type: 'tool_use' as const, toolName: 'Bash', input: {}, status: 'complete' as const, isError: false },
      { type: 'tool_use' as const, toolName: 'Bash', input: {}, status: 'complete' as const, isError: false },
    ]
    const label = toolGroupLabel(tools)
    expect(label).toBe('Used 3 tools — Bash ×3')
  })

  it('lists multiple distinct tools in insertion order', () => {
    const tools = [
      { type: 'tool_use' as const, toolName: 'Bash', input: {}, status: 'complete' as const, isError: false },
      { type: 'tool_use' as const, toolName: 'Bash', input: {}, status: 'complete' as const, isError: false },
      { type: 'tool_use' as const, toolName: 'Read', input: {}, status: 'complete' as const, isError: false },
    ]
    const label = toolGroupLabel(tools)
    expect(label).toBe('Used 3 tools — Bash ×2, Read')
  })
})
