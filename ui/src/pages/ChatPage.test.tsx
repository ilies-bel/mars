/**
 * Tests for ChatPage after the AI-Elements migration.
 *
 * The message-rendering pipeline is now two pieces:
 *   1. `chatMessageToUIMessage` (shared/chatMessageMapping) — the pure
 *      persisted-segment → UIMessage-parts normaliser. This replaces the old
 *      `groupMessageSegments`/`toolGroupLabel` helpers; its correctness is the
 *      most important property for the transcript.
 *   2. `MessageView` (ChatPage) — renders one `MarsUIMessage` through AI
 *      Elements (Response / Reasoning / Tool) plus the bespoke alert / result /
 *      error / attachment surfaces that have no first-class AI-SDK part.
 *
 * The real captured fixture is exercised end-to-end to guard the historical
 * message-drop regression (tool_result segments silently discarding a message).
 */

import { describe, it, expect } from 'bun:test'
// vi must come from 'vitest' directly so that vi.mock() calls are recognised
// and hoisted by vitest's transformer. beforeEach/afterEach come along for
// consistency with the interactive tests below.
import { vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  MessageView,
  FeedbackControls,
  HeroSuggestions,
  AttachmentDisplay,
  ThinkingIndicator,
  LiveAssistantBubble,
  Composer,
} from './ChatPage'
import { emptyLiveBuffer, applyLiveEvent } from '@/shared/chatBuffer'
import { pickTopAlert, resolveMediaKind, fileMediaKind } from './chatPageUtils'
import { chatMessageToUIMessage } from '@/shared/chatMessageMapping'
import { chatThreadDetailSchema } from '@/shared/schemas'
import type { ChatMessage, ActionQueueItem, ChatFeedback, ChatSegmentAlert, ChatSegmentAttachment } from '@/shared/schemas'
import type { MarsUIMessage } from '@/shared/marsChatTransport'
import fixture from './__fixtures__/chat-thread-fixture.json'

vi.mock('@/shared/api', () => ({
  fetchChatThreads: vi.fn().mockResolvedValue([]),
  fetchChatThread: vi.fn().mockResolvedValue(null),
  fetchActionQueue: vi.fn().mockResolvedValue([]),
  createChatThread: vi.fn().mockResolvedValue({ id: 'thread-new' }),
  postChatMessage: vi.fn().mockResolvedValue({}),
  uploadAttachment: vi.fn().mockResolvedValue({ id: 'u1', path: '/tmp/u1', mimeType: 'image/png', name: 'f.png', size: 1 }),
  renameChatThread: vi.fn().mockResolvedValue({}),
  stopChatThread: vi.fn().mockResolvedValue({}),
  invokeAction: vi.fn().mockResolvedValue({}),
  setMessageFeedback: vi.fn().mockResolvedValue({}),
  clearMessageFeedback: vi.fn().mockResolvedValue({}),
  fetchChatHistory: vi.fn().mockResolvedValue([]),
  fetchCodexAuthState: vi.fn().mockResolvedValue(null),
  refreshCodexAuth: vi.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {
    kind: string
    constructor(kind: string, message: string) { super(message); this.kind = kind }
  },
}))

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

/** Narrow a mapped part to a tool part (`tool-<name>`). */
const toolParts = (m: MarsUIMessage) => m.parts.filter((p) => p.type.startsWith('tool-'))

// ---------------------------------------------------------------------------
// chatMessageToUIMessage — persisted segments → UIMessage parts
// ---------------------------------------------------------------------------

describe('chatMessageToUIMessage', () => {
  it('maps a lone text segment to a single text part', () => {
    const out = chatMessageToUIMessage(makeMsg([{ type: 'text', text: 'hello' }]))
    expect(out.parts).toEqual([{ type: 'text', text: 'hello', state: 'done' }])
  })

  it('maps a thinking segment to a reasoning part', () => {
    const out = chatMessageToUIMessage(makeMsg([{ type: 'thinking', text: 'thinking...' }]))
    expect(out.parts).toEqual([{ type: 'reasoning', text: 'thinking...', state: 'done' }])
  })

  it('carries the persisted id, role and feedback onto the UIMessage', () => {
    const out = chatMessageToUIMessage(
      makeMsg([{ type: 'text', text: 'hi' }], 'assistant', { rating: 'up', note: null }),
    )
    expect(out.id).toBe('msg-1')
    expect(out.role).toBe('assistant')
    expect(out.metadata?.feedback).toEqual({ rating: 'up', note: null })
  })

  it('emits a separate tool part per tool_use (no grouping)', () => {
    const out = chatMessageToUIMessage(makeMsg([
      { type: 'tool_use', id: 'a', toolName: 'Bash', input: { cmd: 'ls' }, status: 'complete', isError: false },
      { type: 'tool_use', id: 'b', toolName: 'Read', input: { path: '/foo' }, status: 'complete', isError: false },
    ]))
    const tools = toolParts(out)
    expect(tools).toHaveLength(2)
    expect(tools[0]!.type).toBe('tool-Bash')
    expect(tools[1]!.type).toBe('tool-Read')
  })

  it('folds a tool_result into the matching tool_use as output-available', () => {
    const out = chatMessageToUIMessage(makeMsg([
      { type: 'tool_use', id: 'tu-1', toolName: 'Bash', input: { cmd: 'ls' }, status: 'complete', isError: false },
      { type: 'tool_result', tool_use_id: 'tu-1', content: 'file1.ts\nfile2.ts', isError: false },
    ]))
    const tool = toolParts(out)[0] as Extract<MarsUIMessage['parts'][number], { toolCallId: string }>
    expect(tool.state).toBe('output-available')
    expect((tool as { output: unknown }).output).toBe('file1.ts\nfile2.ts')
  })

  it('marks a tool with an error result as output-error', () => {
    const out = chatMessageToUIMessage(makeMsg([
      { type: 'tool_use', id: 'tu-err', toolName: 'Bash', input: {}, status: 'complete', isError: false },
      { type: 'tool_result', tool_use_id: 'tu-err', content: 'Permission denied', isError: true },
    ]))
    const tool = toolParts(out)[0] as { state: string; errorText: string }
    expect(tool.state).toBe('output-error')
    expect(tool.errorText).toBe('Permission denied')
  })

  it('folds tool_results across an interleaved tool_use/tool_result run', () => {
    const out = chatMessageToUIMessage(makeMsg([
      { type: 'tool_use', id: 'tu-a', toolName: 'Read', input: {}, status: 'complete', isError: false },
      { type: 'tool_result', tool_use_id: 'tu-a', content: 'contents', isError: false },
      { type: 'tool_use', id: 'tu-b', toolName: 'Bash', input: {}, status: 'complete', isError: false },
      { type: 'tool_result', tool_use_id: 'tu-b', content: 'output', isError: false },
    ]))
    const tools = toolParts(out) as { output: unknown }[]
    expect(tools).toHaveLength(2)
    expect(tools[0]!.output).toBe('contents')
    expect(tools[1]!.output).toBe('output')
  })

  it('does not mutate the original message segments', () => {
    const toolSeg = { type: 'tool_use' as const, id: 'tu-1', toolName: 'Bash', input: {}, status: 'complete' as const, isError: false }
    chatMessageToUIMessage(makeMsg([
      toolSeg,
      { type: 'tool_result', tool_use_id: 'tu-1', content: 'out', isError: false },
    ]))
    expect(toolSeg.result).toBeUndefined()
  })

  it('drops a thinking segment whose text is empty', () => {
    const out = chatMessageToUIMessage(makeMsg([
      { type: 'text', text: 'before' },
      { type: 'thinking', text: '' },
      { type: 'text', text: 'after' },
    ]))
    expect(out.parts).toEqual([
      { type: 'text', text: 'before', state: 'done' },
      { type: 'text', text: 'after', state: 'done' },
    ])
  })

  it('maps a provider error segment to a data-chatError part', () => {
    const out = chatMessageToUIMessage(makeMsg([
      { type: 'error', message: 'Codex could not authenticate. Sign in and try again.' },
    ]))
    expect(out.parts).toEqual([
      { type: 'data-chatError', data: { message: 'Codex could not authenticate. Sign in and try again.' } },
    ])
  })

  it('folds a result segment into message metadata usage', () => {
    const out = chatMessageToUIMessage(makeMsg([
      { type: 'text', text: 'done' },
      { type: 'result', durationMs: 1000, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cost: 0.001 },
    ]))
    // No result part — usage rides as metadata.
    expect(out.parts.some((p) => p.type === 'data-result')).toBe(false)
    expect(out.metadata?.usage).toEqual({
      durationMs: 1000, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cost: 0.001,
    })
  })

  it('maps an attachment segment to a data-attachment part', () => {
    const out = chatMessageToUIMessage(makeMsg([
      { type: 'attachment', path: 'img.png', mimeType: 'image/png', name: 'img.png' },
    ]))
    expect(out.parts[0]!.type).toBe('data-attachment')
  })

  it('returns an empty parts array for a message with no segments', () => {
    expect(chatMessageToUIMessage(makeMsg([])).parts).toEqual([])
  })

  it('maps a tool_use with status=proposed to a data-proposedToolCall part', () => {
    const out = chatMessageToUIMessage(makeMsg([
      { type: 'tool_use', id: 'tu-p', toolName: 'mars_restart', input: { taskId: 'task-1' }, status: 'proposed', isError: false },
    ]))
    expect(out.parts).toHaveLength(1)
    expect(out.parts[0]!.type).toBe('data-proposedToolCall')
    const part = out.parts[0] as { type: string; data: { toolName: string; input: unknown; toolCallId: string } }
    expect(part.data.toolName).toBe('mars_restart')
    expect(part.data.input).toEqual({ taskId: 'task-1' })
    expect(part.data.toolCallId).toBe('tu-p')
  })

  it('does not fold a tool_result into a proposed tool_use', () => {
    const out = chatMessageToUIMessage(makeMsg([
      { type: 'tool_use', id: 'tu-p', toolName: 'mars_restart', input: { taskId: 'task-1' }, status: 'proposed', isError: false },
      { type: 'tool_result', tool_use_id: 'tu-p', content: 'restarted', isError: false },
    ]))
    // proposed part survives; tool_result is silently dropped
    expect(out.parts).toHaveLength(1)
    expect(out.parts[0]!.type).toBe('data-proposedToolCall')
  })
})

// ---------------------------------------------------------------------------
// Proposed tool_use — proposed-state rendering via MessageView
// ---------------------------------------------------------------------------

describe('MessageView – proposed tool_use rendering', () => {
  it('renders a proposed tool_use as a "Proposed — awaiting your confirmation" card', () => {
    const msg = chatMessageToUIMessage(makeMsg([
      { type: 'tool_use', id: 'tu-p', toolName: 'mars_restart', input: { taskId: 'task-1' }, status: 'proposed', isError: false },
    ]))
    const html = renderToStaticMarkup(
      createElement(MessageView, { message: msg, onDiscuss: () => undefined }),
    )
    expect(html).toContain('Proposed — awaiting your confirmation')
    expect(html).toContain('mars_restart')
    expect(html).toContain('task-1')
    expect(html).toContain('data-testid="proposed-tool-call"')
  })

  it('does NOT render a ToolGroup for a proposed tool_use', () => {
    const msg = chatMessageToUIMessage(makeMsg([
      { type: 'tool_use', id: 'tu-p', toolName: 'mars_restart', input: {}, status: 'proposed', isError: false },
    ]))
    const html = renderToStaticMarkup(
      createElement(MessageView, { message: msg, onDiscuss: () => undefined }),
    )
    // ToolGroup would render a 'Pending'/'Running'/'Completed' status badge — none should appear
    expect(html).not.toContain('Pending')
    expect(html).not.toContain('Completed')
    expect(html).not.toContain('Running')
  })

  it('renders executed tool_use normally (not as proposed) even when a proposed one is also present', () => {
    const msg = chatMessageToUIMessage(makeMsg([
      { type: 'tool_use', id: 'tu-p', toolName: 'mars_snooze', input: {}, status: 'proposed', isError: false },
      { type: 'tool_use', id: 'tu-c', toolName: 'Bash', input: { cmd: 'ls' }, status: 'complete', isError: false },
      { type: 'tool_result', tool_use_id: 'tu-c', content: 'file1.ts', isError: false },
    ]))
    const html = renderToStaticMarkup(
      createElement(MessageView, { message: msg, onDiscuss: () => undefined }),
    )
    // Proposed card is present
    expect(html).toContain('Proposed — awaiting your confirmation')
    expect(html).toContain('mars_snooze')
    // Executed tool still renders via ToolGroup (shows 'Completed' badge)
    expect(html).toContain('Bash')
    expect(html).toContain('Completed')
  })
})

// ---------------------------------------------------------------------------
// ChatResponseError — error banner message rendering via MessageView
// ---------------------------------------------------------------------------

describe('ChatResponseError – message rendering', () => {
  it('renders the specific error message from data-chatError part', () => {
    const msg = chatMessageToUIMessage(makeMsg([
      { type: 'error', message: 'Codex could not authenticate. Sign in and try again.' },
    ]))
    const html = renderToStaticMarkup(
      createElement(MessageView, { message: msg, onRetry: () => undefined }),
    )
    expect(html).toContain('Codex could not authenticate. Sign in and try again.')
    expect(html).not.toContain('Codex could not finish this reply.')
  })

  it('renders the generic fallback when error message is empty', () => {
    const msg = chatMessageToUIMessage(makeMsg([
      { type: 'error', message: '' },
    ]))
    const html = renderToStaticMarkup(
      createElement(MessageView, { message: msg, onRetry: () => undefined }),
    )
    expect(html).toContain('Codex could not finish this reply. Send another message to try again.')
  })

  it('keeps the "Response interrupted" heading and "Try again" button regardless of message', () => {
    const msg = chatMessageToUIMessage(makeMsg([
      { type: 'error', message: 'Provider quota exceeded.' },
    ]))
    const html = renderToStaticMarkup(
      createElement(MessageView, { message: msg, onRetry: () => undefined }),
    )
    expect(html).toContain('Response interrupted')
    expect(html).toContain('Try again')
  })
})

// ---------------------------------------------------------------------------
// ChatResponseError — direct retry (no synthetic prompt insertion)
// ---------------------------------------------------------------------------

describe('ChatResponseError – direct retry path', () => {
  it('Try again button does not insert "Please retry my last request." into the output', () => {
    // The old code called onDiscuss('Please retry my last request.') which would
    // fill the composer with a visible synthetic message. The new code calls
    // onRetry() with no arguments — a direct resubmit of the last user message.
    const msg = chatMessageToUIMessage(makeMsg([
      { type: 'error', message: 'Provider quota exceeded.' },
    ]))
    const html = renderToStaticMarkup(
      createElement(MessageView, { message: msg, onRetry: () => undefined }),
    )
    // Try again button must still render
    expect(html).toContain('Try again')
    // The synthetic retry string must NEVER appear in the rendered output
    expect(html).not.toContain('Please retry my last request.')
  })

  it('MessageView accepts onRetry: () => void (zero-argument callback, not string-argument)', () => {
    // The interface changed from onDiscuss: (prompt: string) => void to
    // onRetry: () => void. This test documents that contract: if the wrong
    // signature were expected, TypeScript would reject this at compile time.
    const msg = chatMessageToUIMessage(makeMsg([
      { type: 'error', message: 'An error occurred.' },
    ]))
    // Providing () => undefined (zero args) must compile and render without error.
    const html = renderToStaticMarkup(
      createElement(MessageView, { message: msg, onRetry: () => undefined }),
    )
    expect(html).toContain('Response interrupted')
  })

  it('error message part renders the Try again button once (not duplicated via onRetry wiring)', () => {
    const msg = chatMessageToUIMessage(makeMsg([
      { type: 'error', message: 'Something went wrong.' },
    ]))
    const html = renderToStaticMarkup(
      createElement(MessageView, { message: msg, onRetry: () => undefined }),
    )
    // Exactly one Try again button — not doubled up from a stale onDiscuss path
    const count = (html.match(/Try again/g) ?? []).length
    expect(count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Schema round-trip + mapping regression — real captured fixture
//
// The fixture is an assistant reply:
//   text → tool_use → tool_result → thinking(empty) → tool_use → tool_result
//   → text → result
// ---------------------------------------------------------------------------

describe('real fixture regression', () => {
  it('parses the fixture without error and returns 2 messages', () => {
    const parsed = chatThreadDetailSchema.parse(fixture)
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0]!.role).toBe('user')
    expect(parsed.messages[1]!.role).toBe('assistant')
  })

  it('assistant message keeps both tool_use and both tool_result segments', () => {
    const parsed = chatThreadDetailSchema.parse(fixture)
    const assistantMsg = parsed.messages[1]!
    expect(assistantMsg.segments.filter((s) => s.type === 'tool_use')).toHaveLength(2)
    expect(assistantMsg.segments.filter((s) => s.type === 'tool_result')).toHaveLength(2)
  })

  it('maps the fixture assistant message to text, 2 tools, text (+usage), empty thinking dropped', () => {
    const parsed = chatThreadDetailSchema.parse(fixture)
    const out = chatMessageToUIMessage(parsed.messages[1]!)
    const kinds = out.parts.map((p) => (p.type.startsWith('tool-') ? 'tool' : p.type))
    expect(kinds).toEqual(['text', 'tool', 'tool', 'text'])
    // Both tools resolved with their outputs.
    const tools = toolParts(out) as { state: string; type: string }[]
    expect(tools.every((t) => t.state === 'output-available')).toBe(true)
    expect(tools.every((t) => t.type === 'tool-Bash')).toBe(true)
    // Usage folded to metadata; empty thinking produced no reasoning part.
    expect(out.metadata?.usage?.outputTokens).toBe(378)
    expect(out.parts.some((p) => p.type === 'reasoning')).toBe(false)
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
    expect(parsed.messages[0]!.segments).toHaveLength(2)
    expect(parsed.messages[0]!.segments[0]).toMatchObject({ type: 'text', text: 'hello' })
    expect(parsed.messages[0]!.segments[1]).toMatchObject({ type: 'text', text: 'world' })
  })

  it('renders the fixture assistant message with both tools and the final text + usage footer', () => {
    const parsed = chatThreadDetailSchema.parse(fixture)
    const msg = chatMessageToUIMessage(parsed.messages[1]!)
    const html = renderToStaticMarkup(
      createElement(MessageView, { message: msg, onRetry: () => undefined }),
    )
    // Tool panels show the tool name (Bash).
    expect(html).toContain('Bash')
    // Final text is rendered (markdown bold → <strong>).
    expect(html).toContain('Nothing pending')
    // Usage footer: duration and token count.
    expect(html).toContain('8.4s')
    expect(html).toContain('0 tokens')
    // Empty thinking must NOT surface a reasoning block.
    expect(html).not.toContain('Thought for')
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
  it('renders only quick-action chips when no alert is open', () => {
    const html = renderToStaticMarkup(
      createElement(HeroSuggestions, { alerts: [], onAlertClick: () => {}, onChipClick: () => {}, onWhatHappened: () => {} }),
    )
    expect(html).not.toContain('hero-alert-preview')
    expect(html).toContain('Groom the action queue')
    expect(html).toContain('Grill an idea')
    expect(html).toContain('Enqueue a task')
  })
})

describe('HeroSuggestions – with alert', () => {
  it('renders the top alert as a conversation preview before quick actions', () => {
    const alert = makeAlert({ title: 'Deploy is broken', body: 'Failed with exit code 1' })
    const html = renderToStaticMarkup(
      createElement(HeroSuggestions, { alerts: [alert], onAlertClick: () => {}, onChipClick: () => {}, onWhatHappened: () => {} }),
    )
    expect(html).toContain('Deploy is broken')
    expect(html).toContain('Open conversation')
    const alertPos = html.indexOf('hero-alert-preview')
    const chipPos = html.indexOf('Groom the action queue')
    expect(alertPos).toBeLessThan(chipPos)
  })

  it('shows the kind icon for a failed-task alert', () => {
    const alert = makeAlert({ kind: 'failed-task' })
    const html = renderToStaticMarkup(
      createElement(HeroSuggestions, { alerts: [alert], onAlertClick: () => {}, onChipClick: () => {}, onWhatHappened: () => {} }),
    )
    expect(html).toContain('⚠️')
  })

  it('shows the kind icon for a draft-proposal alert', () => {
    const alert = makeAlert({ kind: 'draft-proposal' })
    const html = renderToStaticMarkup(
      createElement(HeroSuggestions, { alerts: [alert], onAlertClick: () => {}, onChipClick: () => {}, onWhatHappened: () => {} }),
    )
    expect(html).toContain('💡')
  })

  it('keeps other open alerts available as compact conversation choices', () => {
    const first = makeAlert({ id: 'first', title: 'First alert', priority: 'high' })
    const second = makeAlert({ id: 'second', title: 'Second alert', priority: 'normal' })
    const html = renderToStaticMarkup(
      createElement(HeroSuggestions, { alerts: [first, second], onAlertClick: () => {}, onChipClick: () => {}, onWhatHappened: () => {} }),
    )
    expect(html).toContain('First alert')
    expect(html).toContain('Second alert')
    expect(html).toContain('hero-alert-option')
  })
})

// ---------------------------------------------------------------------------
// HeroSuggestions – chip text handling (truncation + de-duplication)
// ---------------------------------------------------------------------------

describe('HeroSuggestions – chip text handling', () => {
  /** Renders with topAlert=first and one other-alert chip=second. */
  const renderWithOtherAlert = (chipTitle: string, extraAlerts: Partial<ActionQueueItem>[] = []) => {
    const top = makeAlert({ id: 'top', title: 'Top alert' })
    const other = makeAlert({ id: 'other', title: chipTitle })
    const rest = extraAlerts.map((o, i) => makeAlert({ id: `extra-${i}`, ...o }))
    return renderToStaticMarkup(
      createElement(HeroSuggestions, {
        alerts: [top, other, ...rest],
        onAlertClick: () => {},
        onChipClick: () => {},
        onWhatHappened: () => {},
      }),
    )
  }

  it('caps chip text at 40 characters with an ellipsis when title is long', () => {
    const longTitle = 'A pipeline step did not complete because of a very deep error in the subsystem'
    const html = renderWithOtherAlert(longTitle)
    // Should not contain the full long title in a chip
    expect(html).not.toContain(`>${longTitle}<`)
    // Should contain the first 40 chars followed by an ellipsis
    const truncated = longTitle.slice(0, 40) + '…'
    expect(html).toContain(truncated)
  })

  it('strips the dash separator portion from a long title to avoid duplicated text appearance', () => {
    // A title like "A pipeline step did not complete — A pipeline step di…" triggers the bug
    const titleWithDash = 'A pipeline step did not complete — extra context about the failure'
    const html = renderWithOtherAlert(titleWithDash)
    // The chip's visible label span must not contain the dash separator.
    // (The full title with dash is preserved in the `title` attribute for hover.)
    expect(html).toContain('>A pipeline step did not complete</span>')
    // The after-dash portion must not appear as visible text inside a span element
    expect(html).not.toContain('>A pipeline step did not complete — extra context')
  })

  it('adds a title attribute containing the full alert title for hover tooltip', () => {
    const title = 'Some alert that needs attention'
    const html = renderWithOtherAlert(title)
    // The hero-alert-option chip must expose the full title via the title attribute
    // so users can hover to see the complete text even when it is truncated.
    const chipSection = html.slice(html.indexOf('hero-alert-option'))
    expect(chipSection).toContain(`title="${title}"`)
  })

  it('adds a title attribute with the full long title even when chip text is truncated', () => {
    const longTitle = 'A pipeline step did not complete because of a very deep error in the subsystem'
    const html = renderWithOtherAlert(longTitle)
    expect(html).toContain(`title="${longTitle}"`)
  })

  it('shows at most 1 alert-sourced chip regardless of how many other-alerts exist', () => {
    const html = renderWithOtherAlert('Second alert', [
      { id: 'extra-1', title: 'Third alert' },
      { id: 'extra-2', title: 'Fourth alert' },
    ])
    // Only one hero-alert-option chip should be present
    const chipCount = (html.match(/data-testid="hero-alert-option"/g) ?? []).length
    expect(chipCount).toBe(1)
    // The shown chip is the first other-alert (second in the list after top)
    expect(html).toContain('Second alert')
    expect(html).not.toContain('Third alert')
    expect(html).not.toContain('Fourth alert')
  })

  it('shows a short title intact without truncation', () => {
    const shortTitle = 'Short title'
    const html = renderWithOtherAlert(shortTitle)
    expect(html).toContain(shortTitle)
    expect(html).not.toContain(shortTitle + '…')
  })
})

// ---------------------------------------------------------------------------
// Feedback controls — structure and accessibility
// ---------------------------------------------------------------------------

describe('FeedbackControls – structure', () => {
  it('renders a "helpful" and a "not helpful" button', () => {
    const html = renderToStaticMarkup(
      createElement(FeedbackControls, { messageId: 'msg-1', feedback: null, onFeedbackChange: () => {} }),
    )
    expect(html).toContain('aria-label="helpful"')
    expect(html).toContain('aria-label="not helpful"')
  })

  it('marks the helpful button as pressed when rating is "up"', () => {
    const html = renderToStaticMarkup(
      createElement(FeedbackControls, { messageId: 'msg-1', feedback: { rating: 'up', note: null }, onFeedbackChange: () => {} }),
    )
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="helpful"|aria-label="helpful"[^>]*aria-pressed="true"/)
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="not helpful"|aria-label="not helpful"[^>]*aria-pressed="false"/)
  })

  it('marks the not-helpful button as pressed when rating is "down"', () => {
    const html = renderToStaticMarkup(
      createElement(FeedbackControls, { messageId: 'msg-1', feedback: { rating: 'down', note: null }, onFeedbackChange: () => {} }),
    )
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="helpful"|aria-label="helpful"[^>]*aria-pressed="false"/)
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="not helpful"|aria-label="not helpful"[^>]*aria-pressed="true"/)
  })

  it('shows the note text when a down rating has a note', () => {
    const html = renderToStaticMarkup(
      createElement(FeedbackControls, { messageId: 'msg-1', feedback: { rating: 'down', note: 'wrong answer' }, onFeedbackChange: () => {} }),
    )
    expect(html).toContain('wrong answer')
  })

  it('does not show note text when rating is "up"', () => {
    const html = renderToStaticMarkup(
      createElement(FeedbackControls, { messageId: 'msg-1', feedback: { rating: 'up', note: null }, onFeedbackChange: () => {} }),
    )
    expect(html).not.toContain('wrong answer')
  })
})

// ---------------------------------------------------------------------------
// MessageView — role, feedback presence, and Mars-specific surfaces
// ---------------------------------------------------------------------------

/** Minimal unresolved alert segment. */
const makeAlertSeg = (): ChatSegmentAlert => ({
  type: 'alert',
  kind: 'failed-task',
  entityId: 'task-1',
  priority: 'normal',
  title: 'Task failed',
  whyNow: 'Just now',
  actions: [],
  resolved: false,
})

const renderMessage = (msg: ChatMessage) =>
  renderToStaticMarkup(
    createElement(MessageView, { message: chatMessageToUIMessage(msg), onRetry: () => {} }),
  )

describe('MessageView – role + content', () => {
  it('renders an assistant text message and tags its role', () => {
    const html = renderMessage(makeMsg([{ type: 'text', text: 'hi there' }], 'assistant'))
    expect(html).toContain('data-message-role="assistant"')
    expect(html).toContain('is-assistant')
    expect(html).toContain('hi there')
  })

  it('renders a user message with the user role marker', () => {
    const html = renderMessage(makeMsg([{ type: 'text', text: 'hello' }], 'user'))
    expect(html).toContain('data-message-role="user"')
    expect(html).toContain('is-user')
  })

  it('renders a pure-alert assistant message via AlertCard without the message bubble', () => {
    const html = renderMessage(makeMsg([makeAlertSeg()], 'assistant'))
    expect(html).toContain('Task failed')
    // Alert-only messages are not wrapped in the AI-Elements Message bubble.
    expect(html).not.toContain('is-assistant')
  })

  it('assistant text message renders inside a bordered card with surface background', () => {
    const html = renderMessage(makeMsg([{ type: 'text', text: 'hello' }], 'assistant'))
    // Card chrome: bordered message box with a surface background and padding
    expect(html).toContain('border')
    expect(html).toContain('bg-card')
    expect(html).toContain('px-3')
  })

  it('pure-alert assistant message does not gain a redundant outer border', () => {
    const html = renderMessage(makeMsg([makeAlertSeg()], 'assistant'))
    // AlertCard owns its own card chrome — no is-assistant wrapper should add another border
    expect(html).not.toContain('is-assistant')
    // AlertCard itself still renders its own styled card
    expect(html).toContain('Task failed')
  })
})

describe('MessageView – usage footer position', () => {
  it('renders usage metadata outside the bordered message content box', () => {
    const msg = chatMessageToUIMessage(makeMsg([
      { type: 'text', text: 'done' },
      { type: 'result', durationMs: 8400, inputTokens: 100, outputTokens: 284, cacheReadTokens: 0, cost: 0.001 },
    ]))
    const html = renderToStaticMarkup(
      createElement(MessageView, { message: msg, onDiscuss: () => undefined }),
    )
    // Usage footer content must still render.
    expect(html).toContain('0 tokens')

    // Structural check: usage footer is OUTSIDE the bordered message box (bg-card).
    // In the old (inside) layout, usage appeared in the HTML before feedback controls.
    // In the new (outside) layout, feedback controls are inside the box and appear
    // before the usage footer, which is a sibling below the box.
    const feedbackIdx = html.indexOf('aria-label="helpful"')
    const usageIdx = html.indexOf('0 tokens')
    expect(feedbackIdx).toBeGreaterThan(-1)
    expect(usageIdx).toBeGreaterThan(-1)
    // Feedback (inside box) must appear before usage (outside box).
    expect(feedbackIdx).toBeLessThan(usageIdx)
  })
})

describe('MessageView – feedback controls presence', () => {
  it('assistant messages render feedback controls', () => {
    const html = renderMessage(makeMsg([{ type: 'text', text: 'hi' }], 'assistant'))
    expect(html).toContain('aria-label="helpful"')
    expect(html).toContain('aria-label="not helpful"')
  })

  it('user messages do NOT render feedback controls', () => {
    const html = renderMessage(makeMsg([{ type: 'text', text: 'hello' }], 'user'))
    expect(html).not.toContain('aria-label="helpful"')
    expect(html).not.toContain('aria-label="not helpful"')
  })

  it('assistant message with up rating shows helpful button as pressed', () => {
    const html = renderMessage(makeMsg([{ type: 'text', text: 'hello' }], 'assistant', { rating: 'up', note: null }))
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="helpful"|aria-label="helpful"[^>]*aria-pressed="true"/)
  })

  it('renders an interrupted response with the persisted error message from the segment', () => {
    const html = renderMessage(makeMsg([
      { type: 'error', message: 'Monthly account limit reached.' },
    ], 'assistant'))
    expect(html).toContain('role="alert"')
    expect(html).toContain('Response interrupted')
    expect(html).toContain('Monthly account limit reached.')
    expect(html).toContain('Try again')
    expect(html).not.toContain('Codex could not finish this reply.')
  })
})

// ---------------------------------------------------------------------------
// resolveMediaKind — attachment kind derivation
// ---------------------------------------------------------------------------

const makeAttachment = (overrides: Partial<ChatSegmentAttachment> = {}): ChatSegmentAttachment => ({
  type: 'attachment',
  path: 'file.bin',
  mimeType: 'application/octet-stream',
  name: 'file.bin',
  ...overrides,
})

describe('resolveMediaKind', () => {
  it('returns kindHint when present, overriding mimeType', () => {
    expect(resolveMediaKind(makeAttachment({ kindHint: 'audio', mimeType: 'image/png' }))).toBe('audio')
  })

  it('derives "image" from image/* mimeType when no kindHint', () => {
    expect(resolveMediaKind(makeAttachment({ mimeType: 'image/jpeg' }))).toBe('image')
    expect(resolveMediaKind(makeAttachment({ mimeType: 'image/png' }))).toBe('image')
  })

  it('derives "audio" from audio/* mimeType when no kindHint', () => {
    expect(resolveMediaKind(makeAttachment({ mimeType: 'audio/mpeg' }))).toBe('audio')
    expect(resolveMediaKind(makeAttachment({ mimeType: 'audio/webm' }))).toBe('audio')
  })

  it('derives "video" from video/* mimeType when no kindHint', () => {
    expect(resolveMediaKind(makeAttachment({ mimeType: 'video/mp4' }))).toBe('video')
    expect(resolveMediaKind(makeAttachment({ mimeType: 'video/webm' }))).toBe('video')
  })

  it('returns "other" for unrecognised MIME types', () => {
    expect(resolveMediaKind(makeAttachment({ mimeType: 'application/pdf' }))).toBe('other')
    expect(resolveMediaKind(makeAttachment({ mimeType: 'text/plain' }))).toBe('other')
  })

  it('is case-insensitive for mimeType prefix matching', () => {
    expect(resolveMediaKind(makeAttachment({ mimeType: 'IMAGE/PNG' }))).toBe('image')
    expect(resolveMediaKind(makeAttachment({ mimeType: 'Audio/Ogg' }))).toBe('audio')
  })
})

// ---------------------------------------------------------------------------
// fileMediaKind — File MIME-type to kind mapping
// ---------------------------------------------------------------------------

describe('fileMediaKind', () => {
  const makeFile = (name: string, type: string) => new File([], name, { type })

  it('returns "image" for image/* types', () => {
    expect(fileMediaKind(makeFile('photo.jpg', 'image/jpeg'))).toBe('image')
    expect(fileMediaKind(makeFile('icon.png', 'image/png'))).toBe('image')
  })

  it('returns "audio" for audio/* types', () => {
    expect(fileMediaKind(makeFile('track.mp3', 'audio/mpeg'))).toBe('audio')
    expect(fileMediaKind(makeFile('note.webm', 'audio/webm'))).toBe('audio')
  })

  it('returns "video" for video/* types', () => {
    expect(fileMediaKind(makeFile('clip.mp4', 'video/mp4'))).toBe('video')
    expect(fileMediaKind(makeFile('screen.webm', 'video/webm'))).toBe('video')
  })

  it('returns "other" for non-media types', () => {
    expect(fileMediaKind(makeFile('doc.pdf', 'application/pdf'))).toBe('other')
    expect(fileMediaKind(makeFile('data.json', 'application/json'))).toBe('other')
  })
})

// ---------------------------------------------------------------------------
// AttachmentDisplay — transcript rendering for each media kind
// ---------------------------------------------------------------------------

describe('AttachmentDisplay – image', () => {
  it('renders an img element with data-testid="attachment-image"', () => {
    const attachment = makeAttachment({ mimeType: 'image/png', path: 'photos/snap.png', name: 'snap.png' })
    const html = renderToStaticMarkup(createElement(AttachmentDisplay, { attachment }))
    expect(html).toContain('data-testid="attachment-image"')
    expect(html).toContain('<img')
    expect(html).toContain('snap.png')
  })

  it('builds src URL via /api/chat/uploads/ with encoded path', () => {
    const attachment = makeAttachment({ mimeType: 'image/jpeg', path: 'thread-1/photo.jpg', name: 'photo.jpg' })
    const html = renderToStaticMarkup(createElement(AttachmentDisplay, { attachment }))
    expect(html).toContain('/api/chat/uploads/')
    expect(html).toContain(encodeURIComponent('thread-1/photo.jpg'))
  })

  it('wraps the image in a link that opens full size', () => {
    const attachment = makeAttachment({ mimeType: 'image/png', path: 'img.png', name: 'img.png' })
    const html = renderToStaticMarkup(createElement(AttachmentDisplay, { attachment }))
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})

describe('AttachmentDisplay – audio', () => {
  it('renders an audio element with controls and data-testid="attachment-audio"', () => {
    const attachment = makeAttachment({ mimeType: 'audio/mpeg', path: 'sound.mp3', name: 'sound.mp3' })
    const html = renderToStaticMarkup(createElement(AttachmentDisplay, { attachment }))
    expect(html).toContain('data-testid="attachment-audio"')
    expect(html).toContain('<audio')
    expect(html).toContain('sound.mp3')
  })
})

describe('AttachmentDisplay – video', () => {
  it('renders a video element with controls and data-testid="attachment-video"', () => {
    const attachment = makeAttachment({ mimeType: 'video/mp4', path: 'clip.mp4', name: 'clip.mp4' })
    const html = renderToStaticMarkup(createElement(AttachmentDisplay, { attachment }))
    expect(html).toContain('data-testid="attachment-video"')
    expect(html).toContain('<video')
    expect(html).toContain('clip.mp4')
  })
})

describe('AttachmentDisplay – other', () => {
  it('renders a download link with data-testid="attachment-other"', () => {
    const attachment = makeAttachment({ mimeType: 'application/pdf', path: 'report.pdf', name: 'report.pdf' })
    const html = renderToStaticMarkup(createElement(AttachmentDisplay, { attachment }))
    expect(html).toContain('data-testid="attachment-other"')
    expect(html).toContain('report.pdf')
    expect(html).toContain('target="_blank"')
  })

  it('uses kindHint to force image rendering even for application/octet-stream', () => {
    const attachment = makeAttachment({ mimeType: 'application/octet-stream', kindHint: 'image', path: 'f.bin', name: 'f.bin' })
    const html = renderToStaticMarkup(createElement(AttachmentDisplay, { attachment }))
    expect(html).toContain('data-testid="attachment-image"')
  })
})

// ---------------------------------------------------------------------------
// MessageView — attachment segment integration (via data-attachment parts)
// ---------------------------------------------------------------------------

describe('MessageView – attachment segment rendering', () => {
  it('renders an image attachment inline in the transcript', () => {
    const html = renderMessage(makeMsg([
      { type: 'text', text: 'Here is the screenshot:' },
      { type: 'attachment', path: 'img.png', mimeType: 'image/png', name: 'img.png' },
    ]))
    expect(html).toContain('data-testid="attachment-image"')
    expect(html).toContain('<img')
    expect(html).toContain('Here is the screenshot:')
  })

  it('renders an audio attachment with the audio player', () => {
    const html = renderMessage(makeMsg([
      { type: 'attachment', path: 'voice.webm', mimeType: 'audio/webm', name: 'voice.webm' },
    ]))
    expect(html).toContain('data-testid="attachment-audio"')
    expect(html).toContain('<audio')
  })

  it('renders a video attachment with the video player', () => {
    const html = renderMessage(makeMsg([
      { type: 'attachment', path: 'demo.mp4', mimeType: 'video/mp4', name: 'demo.mp4' },
    ]))
    expect(html).toContain('data-testid="attachment-video"')
    expect(html).toContain('<video')
  })
})

// ---------------------------------------------------------------------------
// ThinkingIndicator — pending/streaming gap placeholder
// ---------------------------------------------------------------------------

describe('ThinkingIndicator', () => {
  it('renders "Thinking…" text visible to the user', () => {
    const html = renderToStaticMarkup(createElement(ThinkingIndicator))
    expect(html).toContain('Thinking')
  })

  it('has role="status" so screen readers announce it', () => {
    const html = renderToStaticMarkup(createElement(ThinkingIndicator))
    expect(html).toContain('role="status"')
  })

  it('has aria-live="polite" on the wrapper', () => {
    const html = renderToStaticMarkup(createElement(ThinkingIndicator))
    expect(html).toContain('aria-live="polite"')
  })

  it('shows three animated bouncing dots, not a single static pulse', () => {
    const html = renderToStaticMarkup(createElement(ThinkingIndicator))
    // Three staggered bounce dots with staggered animation delays
    const bounceCount = (html.match(/animate-bounce/g) ?? []).length
    expect(bounceCount).toBe(3)
    // Must not fall back to the old single-pulse approach
    expect(html).not.toContain('animate-pulse')
  })
})

// ---------------------------------------------------------------------------
// ThinkingIndicator — showThinking condition (thread.status logic)
//
// ChatConversation derives `showThinking` as:
//   status === 'submitted' || (serverRunning && !isBusy)
// where isBusy = status === 'streaming' || status === 'submitted'.
//
// These tests exercise the condition logic that controls when the indicator
// renders, expressed through the ThinkingIndicator component itself.
// ---------------------------------------------------------------------------

describe('ThinkingIndicator – visibility condition', () => {
  /** Simulate the ChatConversation showThinking derivation. */
  function showThinking(status: string, serverRunning: boolean): boolean {
    const isBusy = status === 'streaming' || status === 'submitted'
    return status === 'submitted' || (serverRunning && !isBusy)
  }

  function renderConditional(visible: boolean): string {
    return renderToStaticMarkup(
      visible ? createElement(ThinkingIndicator) : createElement('span', null, ''),
    )
  }

  it('shows indicator when thread is running and no stream has started yet', () => {
    // Simulates thread.status === 'running', useMarsChat status === 'ready'
    const html = renderConditional(showThinking('ready', true))
    expect(html).toContain('Thinking')
  })

  it('shows indicator immediately after the user submits a message', () => {
    // Client-initiated: useMarsChat status flips to 'submitted' on send
    const html = renderConditional(showThinking('submitted', false))
    expect(html).toContain('Thinking')
  })

  it('hides indicator once streaming begins (live buffer exists)', () => {
    // First SSE token received → status becomes 'streaming'; no indicator
    const html = renderConditional(showThinking('streaming', true))
    expect(html).not.toContain('Thinking')
  })

  it('hides indicator when thread is idle and no client send pending', () => {
    const html = renderConditional(showThinking('ready', false))
    expect(html).not.toContain('Thinking')
  })
})

// ---------------------------------------------------------------------------
// LiveAssistantBubble — tool-call status synchronization regression
//
// Guards that the live stream preserves the full AI-SDK tool state set instead
// of collapsing all in-flight calls to "Pending" (input-streaming).
// ---------------------------------------------------------------------------

describe('LiveAssistantBubble — tool state synchronization', () => {
  const renderBubble = (buf: ReturnType<typeof emptyLiveBuffer>) =>
    renderToStaticMarkup(createElement(LiveAssistantBubble, { buffer: buf }))

  it('renders a freshly-started tool call as Pending (input-streaming)', () => {
    const buf = applyLiveEvent(emptyLiveBuffer(), {
      type: 'tool_use', toolUseId: 'id1', toolName: 'Bash', input: { cmd: 'ls' },
    })
    const html = renderBubble(buf)
    expect(html).toContain('Bash')
    expect(html).toContain('Pending')
    expect(html).not.toContain('Running')
    expect(html).not.toContain('Completed')
  })

  it('renders a tool with available input as Running (input-available)', () => {
    const buf = [
      { type: 'tool_use' as const, toolUseId: 'id1', toolName: 'Bash', input: { cmd: 'ls' } },
      { type: 'tool_input_available' as const, toolUseId: 'id1' },
    ].reduce(applyLiveEvent, emptyLiveBuffer())
    const html = renderBubble(buf)
    expect(html).toContain('Bash')
    expect(html).toContain('Running')
    expect(html).not.toContain('Pending')
    expect(html).not.toContain('Completed')
  })

  it('renders a completed tool as Completed (output-available)', () => {
    const buf = [
      { type: 'tool_use' as const, toolUseId: 'id1', toolName: 'Read', input: {} },
      { type: 'tool_result' as const, toolUseId: 'id1', output: 'file contents' },
    ].reduce(applyLiveEvent, emptyLiveBuffer())
    const html = renderBubble(buf)
    expect(html).toContain('Completed')
    expect(html).not.toContain('Pending')
    expect(html).not.toContain('Running')
  })

  it('renders a failed tool as Error (output-error)', () => {
    const buf = [
      { type: 'tool_use' as const, toolUseId: 'id1', toolName: 'Bash', input: { cmd: 'bad' } },
      { type: 'tool_result' as const, toolUseId: 'id1', errorText: 'Permission denied' },
    ].reduce(applyLiveEvent, emptyLiveBuffer())
    const html = renderBubble(buf)
    expect(html).toContain('Error')
    expect(html).not.toContain('Pending')
  })

  it('shows distinct states for two parallel tools in the same group', () => {
    const buf = [
      { type: 'tool_use' as const, toolUseId: 'a', toolName: 'Read', input: {} },
      { type: 'tool_use' as const, toolUseId: 'b', toolName: 'Bash', input: {} },
      // Only advance tool 'a' to input-available; 'b' stays input-streaming
      { type: 'tool_input_available' as const, toolUseId: 'a' },
    ].reduce(applyLiveEvent, emptyLiveBuffer())
    const html = renderBubble(buf)
    // 'a' is Running, 'b' is still Pending — both labels should appear
    expect(html).toContain('Running')
    expect(html).toContain('Pending')
  })

  it('live and persisted paths agree on status labels for output-available tools', () => {
    // Live path: build via chatBuffer reducer
    const liveBuffer = [
      { type: 'tool_use' as const, toolUseId: 'tu', toolName: 'Bash', input: { cmd: 'echo hi' } },
      { type: 'tool_result' as const, toolUseId: 'tu', output: 'hi' },
    ].reduce(applyLiveEvent, emptyLiveBuffer())
    const liveHtml = renderBubble(liveBuffer)

    // Persisted path: chatMessageToUIMessage maps tool_result to output-available
    const persistedMsg = chatMessageToUIMessage(makeMsg([
      { type: 'tool_use', id: 'tu', toolName: 'Bash', input: { cmd: 'echo hi' }, status: 'complete', isError: false },
      { type: 'tool_result', tool_use_id: 'tu', content: 'hi', isError: false },
    ]))
    const persistedHtml = renderToStaticMarkup(
      createElement(MessageView, { message: persistedMsg, onRetry: () => {} }),
    )

    // Both should show "Completed" — neither should show "Pending"
    expect(liveHtml).toContain('Completed')
    expect(persistedHtml).toContain('Completed')
    expect(liveHtml).not.toContain('Pending')
    expect(persistedHtml).not.toContain('Pending')
  })

  it('renders an accessible error card with role="alert" when the stream errors', () => {
    const buf = applyLiveEvent(emptyLiveBuffer(), { type: 'error', message: 'boom' })
    const html = renderBubble(buf)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Codex could not respond.')
    expect(html).toContain('boom')
  })

  it('renders partial output followed by the error card when error arrives after segments', () => {
    const buf = [
      { type: 'text' as const, text: 'partial output' },
      { type: 'error' as const, message: 'quota exceeded' },
    ].reduce(applyLiveEvent, emptyLiveBuffer())
    const html = renderBubble(buf)
    expect(html).toContain('partial output')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Codex could not respond.')
    expect(html).toContain('quota exceeded')
  })
})

// ---------------------------------------------------------------------------
// Slash-palette keyboard navigation
// ---------------------------------------------------------------------------

describe('Slash-palette keyboard navigation', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.clearAllMocks()
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  /** Renders Composer into container, returns the root and an onSend spy. */
  function renderComposerForPalette(onSend = vi.fn().mockResolvedValue(undefined)) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const root = createRoot(container)
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(Composer, {
          threadId: 'thread-1',
          disabled: false,
          onInitialTextConsumed: () => {},
          onSend,
          onStop: vi.fn(),
          isBusy: false,
        }),
      ),
    )
    return { root, onSend }
  }

  /** Types text into the composer textarea by setting its value and firing an input event. */
  async function typeText(textarea: HTMLTextAreaElement, text: string) {
    await act(() => {
      // Use the native value setter so React's controlled-input tracking
      // sees the change, then fire 'input' which React maps to onChange.
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (nativeSetter) {
        nativeSetter.call(textarea, text)
      } else {
        textarea.value = text
      }
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  /** Dispatches a keydown event on the given element. */
  async function pressKey(element: HTMLElement, key: string) {
    await act(() => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }

  it('Tab completes the highlighted skill and closes the palette', async () => {
    await act(() => { renderComposerForPalette() })

    const textarea = container.querySelector('textarea')!
    expect(textarea).not.toBeNull()

    // Type '/gr' — only /grill should match
    await typeText(textarea, '/gr')

    // Palette should be open
    expect(container.querySelector('[role="listbox"]')).not.toBeNull()

    // Tab should select /grill and close the palette
    await pressKey(textarea, 'Tab')

    expect(textarea.value).toBe('Grill this idea into a PRD: ')
    expect(container.querySelector('[role="listbox"]')).toBeNull()
  })

  it('ArrowDown then Tab selects the second match', async () => {
    await act(() => { renderComposerForPalette() })

    const textarea = container.querySelector('textarea')!

    // Type '/' — all commands match; first match is /grill, second is /task
    await typeText(textarea, '/')

    expect(container.querySelector('[role="listbox"]')).not.toBeNull()

    // ArrowDown moves highlight to index 1 (/task)
    await pressKey(textarea, 'ArrowDown')

    // Tab selects /task
    await pressKey(textarea, 'Tab')

    expect(textarea.value).toBe('Enqueue a task: ')
    expect(container.querySelector('[role="listbox"]')).toBeNull()
  })

  it('Enter completes the active match instead of sending when palette is open', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    await act(() => { renderComposerForPalette(onSend) })

    const textarea = container.querySelector('textarea')!

    await typeText(textarea, '/gr')
    expect(container.querySelector('[role="listbox"]')).not.toBeNull()

    // Enter should complete, not send
    await pressKey(textarea, 'Enter')

    expect(onSend).not.toHaveBeenCalled()
    expect(textarea.value).toBe('Grill this idea into a PRD: ')
    expect(container.querySelector('[role="listbox"]')).toBeNull()
  })

  it('Escape closes the palette without altering the typed text', async () => {
    await act(() => { renderComposerForPalette() })

    const textarea = container.querySelector('textarea')!

    await typeText(textarea, '/gr')
    expect(container.querySelector('[role="listbox"]')).not.toBeNull()

    // Escape should close the palette
    await pressKey(textarea, 'Escape')

    expect(container.querySelector('[role="listbox"]')).toBeNull()
    expect(textarea.value).toBe('/gr')
  })
})

// ---------------------------------------------------------------------------
// Attachment segment — mapping and rendering
// (groupMessageSegments was replaced by chatMessageToUIMessage in the
// AI-Elements migration; these tests use the current public API.)
// ---------------------------------------------------------------------------

describe('chatMessageToUIMessage – attachment segment', () => {
  it('maps an attachment segment to a data-attachment part', () => {
    const msg = makeMsg([
      { type: 'attachment', path: 'uploads/img.png', mimeType: 'image/png', name: 'img.png' },
    ])
    const out = chatMessageToUIMessage(msg)
    expect(out.parts).toHaveLength(1)
    expect(out.parts[0]!.type).toBe('data-attachment')
  })

  it('emits a tool part followed by a data-attachment part', () => {
    const msg = makeMsg([
      { type: 'tool_use', toolName: 'Bash', input: {}, status: 'complete' as const, isError: false },
      { type: 'attachment', path: 'uploads/clip.mp4', mimeType: 'video/mp4', name: 'clip.mp4' },
    ])
    const out = chatMessageToUIMessage(msg)
    expect(out.parts).toHaveLength(2)
    expect(out.parts[0]!.type).toBe('tool-Bash')
    expect(out.parts[1]!.type).toBe('data-attachment')
  })

  it('maps a mixed message: text → attachment → text', () => {
    const msg = makeMsg([
      { type: 'text', text: 'here is a file' },
      { type: 'attachment', path: 'uploads/note.m4a', mimeType: 'audio/mp4', name: 'note.m4a' },
      { type: 'text', text: 'end' },
    ])
    const out = chatMessageToUIMessage(msg)
    expect(out.parts).toHaveLength(3)
    expect(out.parts[0]!.type).toBe('text')
    expect(out.parts[1]!.type).toBe('data-attachment')
    expect(out.parts[2]!.type).toBe('text')
  })
})

describe('AttachmentDisplay – attachment rendering', () => {
  it('renders an image attachment as a linked image with the correct src', () => {
    const seg: ChatSegmentAttachment = { type: 'attachment', path: 'uploads/photo.jpg', mimeType: 'image/jpeg', name: 'photo.jpg' }
    const html = renderToStaticMarkup(
      createElement(AttachmentDisplay, { attachment: seg }),
    )
    expect(html).toContain('attachment-image')
    expect(html).toContain('/api/chat/uploads/uploads%2Fphoto.jpg')
    expect(html).toContain('alt="photo.jpg"')
  })

  it('renders an audio attachment as <audio> with controls', () => {
    const seg: ChatSegmentAttachment = { type: 'attachment', path: 'uploads/voice.mp3', mimeType: 'audio/mpeg', name: 'voice.mp3' }
    const html = renderToStaticMarkup(
      createElement(AttachmentDisplay, { attachment: seg }),
    )
    expect(html).toContain('attachment-audio')
    expect(html).toContain('<audio')
    expect(html).toContain('controls')
    expect(html).toContain('/api/chat/uploads/uploads%2Fvoice.mp3')
  })

  it('renders a video attachment as <video> with controls', () => {
    const seg: ChatSegmentAttachment = { type: 'attachment', path: 'uploads/clip.webm', mimeType: 'video/webm', name: 'clip.webm' }
    const html = renderToStaticMarkup(
      createElement(AttachmentDisplay, { attachment: seg }),
    )
    expect(html).toContain('attachment-video')
    expect(html).toContain('<video')
    expect(html).toContain('controls')
    expect(html).toContain('/api/chat/uploads/uploads%2Fclip.webm')
  })

  it('renders an unknown mime type as a link to the file', () => {
    const seg: ChatSegmentAttachment = { type: 'attachment', path: 'uploads/data.csv', mimeType: 'text/csv', name: 'data.csv' }
    const html = renderToStaticMarkup(
      createElement(AttachmentDisplay, { attachment: seg }),
    )
    expect(html).toContain('attachment-other')
    expect(html).toContain('href="/api/chat/uploads/uploads%2Fdata.csv"')
  })
})
