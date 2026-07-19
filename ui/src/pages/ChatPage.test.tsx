/**
 * Tests for ChatPage segment-grouping and label helpers.
 *
 * Segment grouping (groupMessageSegments) and label formatting
 * (toolGroupLabel) are pure functions that describe observable
 * chat-rendering behaviour without requiring a DOM or React rendering.
 * These are the most important correctness properties for the
 * message-rendering pipeline.
 *
 * A render test using the real captured fixture is included to guard against
 * the message-drop regression where tool_result segments caused the whole
 * assistant message to be silently discarded.
 */

import { describe, it, expect } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import {
  groupMessageSegments,
  toolGroupLabel,
  ChatMessageBubble,
  FeedbackControls,
  pickTopAlert,
  HeroSuggestions,
} from './ChatPage'
import { chatThreadDetailSchema } from '@/shared/schemas'
import type { ChatMessage, ChatSegmentToolUse, ActionQueueItem, ChatFeedback } from '@/shared/schemas'
import fixture from './__fixtures__/chat-thread-fixture.json'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeMsg = (
  segments: ChatMessage['segments'],
  role: 'user' | 'assistant' = 'assistant',
  feedback: ChatFeedback | null = null,
): ChatMessage => ({
  id: 'msg-1',
  threadId: 'thread-1',
  role,
  segments,
  createdAt: new Date().toISOString(),
  feedback,
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

  it('attaches tool_result content to the matching tool_use in the same group', () => {
    const msg = makeMsg([
      { type: 'tool_use', id: 'tu-1', toolName: 'Bash', input: { cmd: 'ls' }, status: 'complete', isError: false },
      { type: 'tool_result', tool_use_id: 'tu-1', content: 'file1.ts\nfile2.ts', isError: false },
    ])
    const out = groupMessageSegments(msg)
    // One tool_group containing one enriched tool_use
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('tool_group')
    const group = out[0] as { kind: 'tool_group'; tools: ChatSegmentToolUse[] }
    expect(group.tools).toHaveLength(1)
    expect(group.tools[0]!.result).toBe('file1.ts\nfile2.ts')
  })

  it('tool_result with isError=true marks the matching tool as error', () => {
    const msg = makeMsg([
      { type: 'tool_use', id: 'tu-err', toolName: 'Bash', input: {}, status: 'complete', isError: false },
      { type: 'tool_result', tool_use_id: 'tu-err', content: 'Permission denied', isError: true },
    ])
    const out = groupMessageSegments(msg)
    const group = out[0] as { kind: 'tool_group'; tools: ChatSegmentToolUse[] }
    expect(group.tools[0]!.isError).toBe(true)
    expect(group.tools[0]!.result).toBe('Permission denied')
  })

  it('does not flush the tool group when tool_result is encountered', () => {
    // tool_use → tool_result → tool_use should produce ONE group of two tools
    const msg = makeMsg([
      { type: 'tool_use', id: 'tu-a', toolName: 'Read', input: {}, status: 'complete', isError: false },
      { type: 'tool_result', tool_use_id: 'tu-a', content: 'contents', isError: false },
      { type: 'tool_use', id: 'tu-b', toolName: 'Bash', input: {}, status: 'complete', isError: false },
      { type: 'tool_result', tool_use_id: 'tu-b', content: 'output', isError: false },
    ])
    const out = groupMessageSegments(msg)
    expect(out).toHaveLength(1)
    const group = out[0] as { kind: 'tool_group'; tools: ChatSegmentToolUse[] }
    expect(group.tools).toHaveLength(2)
    expect(group.tools[0]!.result).toBe('contents')
    expect(group.tools[1]!.result).toBe('output')
  })

  it('does not mutate the original message segments when attaching tool_result', () => {
    const toolSeg = { type: 'tool_use' as const, id: 'tu-1', toolName: 'Bash', input: {}, status: 'complete' as const, isError: false }
    const msg = makeMsg([
      toolSeg,
      { type: 'tool_result', tool_use_id: 'tu-1', content: 'out', isError: false },
    ])
    groupMessageSegments(msg)
    // Original segment should be untouched
    expect(toolSeg.result).toBeUndefined()
  })

  it('drops a thinking segment whose text is empty', () => {
    const msg = makeMsg([
      { type: 'text', text: 'before' },
      { type: 'thinking', text: '' },
      { type: 'text', text: 'after' },
    ])
    const out = groupMessageSegments(msg)
    // The empty thinking block is silently dropped
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ kind: 'text', text: 'before' })
    expect(out[1]).toEqual({ kind: 'text', text: 'after' })
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

// ---------------------------------------------------------------------------
// Schema round-trip + render regression — real captured fixture
//
// The fixture is an assistant reply that contains:
//   text → tool_use → tool_result → thinking(empty) → tool_use → tool_result
//   → text → result
//
// Previously, the missing tool_result variant in chatSegmentSchema caused
// parse to fail and the whole assistant message to be silently dropped.
// ---------------------------------------------------------------------------

describe('real fixture regression', () => {
  it('parses the fixture without error and returns 2 messages', () => {
    const parsed = chatThreadDetailSchema.parse(fixture)
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0]!.role).toBe('user')
    expect(parsed.messages[1]!.role).toBe('assistant')
  })

  it('assistant message segments include both tool_use entries (tool_result absorbed)', () => {
    const parsed = chatThreadDetailSchema.parse(fixture)
    const assistantMsg = parsed.messages[1]!
    // Raw segments: text, tool_use, tool_result, thinking(empty), tool_use, tool_result, text, result
    // After parsing: tool_result segments are included in the ChatSegment union
    const toolUseSegments = assistantMsg.segments.filter(s => s.type === 'tool_use')
    const toolResultSegments = assistantMsg.segments.filter(s => s.type === 'tool_result')
    expect(toolUseSegments).toHaveLength(2)
    expect(toolResultSegments).toHaveLength(2)
  })

  it('groupMessageSegments on fixture assistant message yields text, 2 tool_groups, text, result', () => {
    const parsed = chatThreadDetailSchema.parse(fixture)
    const assistantMsg = parsed.messages[1]!
    const flat = groupMessageSegments(assistantMsg)
    // text + tool_group + tool_group + text + result  (empty thinking dropped)
    expect(flat).toHaveLength(5)
    expect(flat[0]!.kind).toBe('text')
    expect(flat[1]!.kind).toBe('tool_group')
    expect(flat[2]!.kind).toBe('tool_group')
    expect(flat[3]!.kind).toBe('text')
    expect(flat[4]!.kind).toBe('result')
  })

  it('each tool_group has exactly one tool with its result attached', () => {
    const parsed = chatThreadDetailSchema.parse(fixture)
    const assistantMsg = parsed.messages[1]!
    const flat = groupMessageSegments(assistantMsg)
    const group1 = flat[1] as { kind: 'tool_group'; tools: ChatSegmentToolUse[] }
    const group2 = flat[2] as { kind: 'tool_group'; tools: ChatSegmentToolUse[] }
    expect(group1.tools).toHaveLength(1)
    expect(group2.tools).toHaveLength(1)
    // Both tools are Bash
    expect(group1.tools[0]!.toolName).toBe('Bash')
    expect(group2.tools[0]!.toolName).toBe('Bash')
    // Results are attached
    expect(group1.tools[0]!.result).toBeDefined()
    expect(group2.tools[0]!.result).toBeDefined()
  })

  it('unknown segment types are silently dropped, not crashing the parse', () => {
    const withUnknown = {
      ...fixture,
      messages: [
        {
          ...fixture.messages[0],
          segments: [
            { type: 'text', text: 'hello' },
            { type: 'future_type_not_yet_known', data: 42 },
            { type: 'text', text: 'world' },
          ],
        },
      ],
    }
    const parsed = chatThreadDetailSchema.parse(withUnknown)
    // The unknown segment is silently dropped; the two text segments survive
    expect(parsed.messages[0]!.segments).toHaveLength(2)
    expect(parsed.messages[0]!.segments[0]).toMatchObject({ type: 'text', text: 'hello' })
    expect(parsed.messages[0]!.segments[1]).toMatchObject({ type: 'text', text: 'world' })
  })

  it('renders the assistant message bubble with both tool groups and final text visible', () => {
    const parsed = chatThreadDetailSchema.parse(fixture)
    const assistantMsg = parsed.messages[1]!
    const html = renderToStaticMarkup(
      createElement(ChatMessageBubble, { msg: assistantMsg, onDiscuss: () => undefined }),
    )
    // Both tool groups (collapsed) show their labels
    expect(html).toContain('Used 1 tool')
    // Final text is rendered (markdown bold → <strong>)
    expect(html).toContain('Nothing pending')
    // Result footer: duration and token count
    expect(html).toContain('8.4s')
    expect(html).toContain('384 tokens')
    // Empty thinking block must NOT appear
    expect(html).not.toContain('Thought process')
  })
})

// ---------------------------------------------------------------------------
// pickTopAlert — hero empty state: alert prioritization
// ---------------------------------------------------------------------------

const makeAlert = (overrides: Partial<ActionQueueItem> = {}): ActionQueueItem => ({
  id: 'alert-1',
  kind: 'failed-task',
  entityId: 'task-1',
  priority: 'normal',
  title: 'Some task failed',
  body: 'It broke.',
  at: '2026-01-01T00:00:00Z',
  dag: null,
  errorKind: 'failed-task',
  actions: [],
  diagnosis: null,
  ...overrides,
} as ActionQueueItem)

describe('pickTopAlert', () => {
  it('returns null for an empty list', () => {
    expect(pickTopAlert([])).toBeNull()
  })

  it('returns the only item for a single-item list', () => {
    const item = makeAlert()
    expect(pickTopAlert([item])).toBe(item)
  })

  it('returns the high-priority item over a normal-priority item', () => {
    const high = makeAlert({ id: 'high', priority: 'high' })
    const normal = makeAlert({ id: 'normal', priority: 'normal' })
    expect(pickTopAlert([normal, high])?.id).toBe('high')
  })

  it('returns the normal-priority item over a low-priority item', () => {
    const normal = makeAlert({ id: 'normal', priority: 'normal' })
    const low = makeAlert({ id: 'low', priority: 'low' })
    expect(pickTopAlert([low, normal])?.id).toBe('normal')
  })

  it('breaks priority ties by most-recent `at` date', () => {
    const older = makeAlert({ id: 'older', priority: 'high', at: '2026-01-01T00:00:00Z' })
    const newer = makeAlert({ id: 'newer', priority: 'high', at: '2026-06-01T00:00:00Z' })
    expect(pickTopAlert([older, newer])?.id).toBe('newer')
  })

  it('high-priority older item beats normal-priority newer item', () => {
    const highOld = makeAlert({ id: 'high', priority: 'high', at: '2020-01-01T00:00:00Z' })
    const normalNew = makeAlert({ id: 'norm', priority: 'normal', at: '2026-12-31T00:00:00Z' })
    expect(pickTopAlert([highOld, normalNew])?.id).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// HeroSuggestions — suggestion chip rendering
// ---------------------------------------------------------------------------

describe('HeroSuggestions – no alert', () => {
  it('renders only quick-action chips when topAlert is null', () => {
    const html = renderToStaticMarkup(
      createElement(HeroSuggestions, { topAlert: null, onAlertClick: () => {}, onChipClick: () => {} }),
    )
    expect(html).not.toContain('hero-alert-chip')
    expect(html).toContain('Groom the action queue')
    expect(html).toContain('Grill an idea')
    expect(html).toContain('Enqueue a task')
  })
})

describe('HeroSuggestions – with alert', () => {
  it('renders the alert chip before the quick-action chips', () => {
    const alert = makeAlert({ title: 'Deploy is broken', body: 'Failed with exit code 1' })
    const html = renderToStaticMarkup(
      createElement(HeroSuggestions, { topAlert: alert, onAlertClick: () => {}, onChipClick: () => {} }),
    )
    // Alert chip present
    expect(html).toContain('Deploy is broken')
    // Alert chip appears before the first regular chip in the DOM order
    const alertPos = html.indexOf('hero-alert-chip')
    const chipPos = html.indexOf('Groom the action queue')
    expect(alertPos).toBeLessThan(chipPos)
  })

  it('shows the kind icon for a failed-task alert', () => {
    const alert = makeAlert({ kind: 'failed-task' })
    const html = renderToStaticMarkup(
      createElement(HeroSuggestions, { topAlert: alert, onAlertClick: () => {}, onChipClick: () => {} }),
    )
    expect(html).toContain('⚠️')
  })

  it('shows the kind icon for a draft-proposal alert', () => {
    const alert = makeAlert({ kind: 'draft-proposal' })
    const html = renderToStaticMarkup(
      createElement(HeroSuggestions, { topAlert: alert, onAlertClick: () => {}, onChipClick: () => {} }),
    )
    expect(html).toContain('💡')
  })
})

// ---------------------------------------------------------------------------
// Feedback controls — structure and accessibility
//
// Tests drive the observable HTML output through renderToStaticMarkup.
// Interactive click paths (API calls, optimistic state transitions) cannot be
// exercised in the SSR/node environment; the HTTP route tests in
// http-chat-routes.test.ts cover the backend contract.
// ---------------------------------------------------------------------------

describe('FeedbackControls – structure', () => {
  it('renders a "helpful" and a "not helpful" button', () => {
    const html = renderToStaticMarkup(
      createElement(FeedbackControls, {
        messageId: 'msg-1',
        feedback: null,
        onFeedbackChange: () => {},
      }),
    )
    expect(html).toContain('aria-label="helpful"')
    expect(html).toContain('aria-label="not helpful"')
  })

  it('marks the helpful button as pressed when rating is "up"', () => {
    const html = renderToStaticMarkup(
      createElement(FeedbackControls, {
        messageId: 'msg-1',
        feedback: { rating: 'up', note: null },
        onFeedbackChange: () => {},
      }),
    )
    // aria-pressed="true" on the helpful button — attributes may appear in any order
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="helpful"|aria-label="helpful"[^>]*aria-pressed="true"/)
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="not helpful"|aria-label="not helpful"[^>]*aria-pressed="false"/)
  })

  it('marks the not-helpful button as pressed when rating is "down"', () => {
    const html = renderToStaticMarkup(
      createElement(FeedbackControls, {
        messageId: 'msg-1',
        feedback: { rating: 'down', note: null },
        onFeedbackChange: () => {},
      }),
    )
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="helpful"|aria-label="helpful"[^>]*aria-pressed="false"/)
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="not helpful"|aria-label="not helpful"[^>]*aria-pressed="true"/)
  })

  it('shows the note text when a down rating has a note', () => {
    const html = renderToStaticMarkup(
      createElement(FeedbackControls, {
        messageId: 'msg-1',
        feedback: { rating: 'down', note: 'wrong answer' },
        onFeedbackChange: () => {},
      }),
    )
    expect(html).toContain('wrong answer')
  })

  it('does not show note text when rating is "up"', () => {
    const html = renderToStaticMarkup(
      createElement(FeedbackControls, {
        messageId: 'msg-1',
        feedback: { rating: 'up', note: null },
        onFeedbackChange: () => {},
      }),
    )
    // The note span is only rendered for 'down' + note
    expect(html).not.toContain('wrong answer')
  })
})

describe('ChatMessageBubble – feedback controls presence', () => {
  it('assistant messages render feedback controls (helpful / not helpful buttons)', () => {
    const msg = makeMsg([{ type: 'text', text: 'hi' }], 'assistant')
    const html = renderToStaticMarkup(
      createElement(ChatMessageBubble, { msg, onDiscuss: () => {} }),
    )
    expect(html).toContain('aria-label="helpful"')
    expect(html).toContain('aria-label="not helpful"')
  })

  it('user messages do NOT render feedback controls', () => {
    const msg = makeMsg([{ type: 'text', text: 'hello' }], 'user')
    const html = renderToStaticMarkup(
      createElement(ChatMessageBubble, { msg, onDiscuss: () => {} }),
    )
    expect(html).not.toContain('aria-label="helpful"')
    expect(html).not.toContain('aria-label="not helpful"')
  })

  it('assistant message with up rating shows helpful button as pressed', () => {
    const msg = makeMsg([{ type: 'text', text: 'hello' }], 'assistant', { rating: 'up', note: null })
    const html = renderToStaticMarkup(
      createElement(ChatMessageBubble, { msg, onDiscuss: () => {} }),
    )
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="helpful"|aria-label="helpful"[^>]*aria-pressed="true"/)
  })
})
