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
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import {
  MessageView,
  FeedbackControls,
  pickTopAlert,
  HeroSuggestions,
  AttachmentDisplay,
  resolveMediaKind,
  fileMediaKind,
} from './ChatPage'
import { chatMessageToUIMessage } from '@/shared/chatMessageMapping'
import { chatThreadDetailSchema } from '@/shared/schemas'
import type { ChatMessage, ActionQueueItem, ChatFeedback, ChatSegmentAlert, ChatSegmentAttachment } from '@/shared/schemas'
import type { MarsUIMessage } from '@/shared/marsChatTransport'
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
      createElement(MessageView, { message: msg, onDiscuss: () => undefined }),
    )
    // Tool panels show the tool name (Bash).
    expect(html).toContain('Bash')
    // Final text is rendered (markdown bold → <strong>).
    expect(html).toContain('Nothing pending')
    // Usage footer: duration and token count.
    expect(html).toContain('8.4s')
    expect(html).toContain('384 tokens')
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
      createElement(HeroSuggestions, { alerts: [], onAlertClick: () => {}, onChipClick: () => {} }),
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
      createElement(HeroSuggestions, { alerts: [alert], onAlertClick: () => {}, onChipClick: () => {} }),
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
      createElement(HeroSuggestions, { alerts: [alert], onAlertClick: () => {}, onChipClick: () => {} }),
    )
    expect(html).toContain('⚠️')
  })

  it('shows the kind icon for a draft-proposal alert', () => {
    const alert = makeAlert({ kind: 'draft-proposal' })
    const html = renderToStaticMarkup(
      createElement(HeroSuggestions, { alerts: [alert], onAlertClick: () => {}, onChipClick: () => {} }),
    )
    expect(html).toContain('💡')
  })

  it('keeps other open alerts available as compact conversation choices', () => {
    const first = makeAlert({ id: 'first', title: 'First alert', priority: 'high' })
    const second = makeAlert({ id: 'second', title: 'Second alert', priority: 'normal' })
    const html = renderToStaticMarkup(
      createElement(HeroSuggestions, { alerts: [first, second], onAlertClick: () => {}, onChipClick: () => {} }),
    )
    expect(html).toContain('First alert')
    expect(html).toContain('Second alert')
    expect(html).toContain('hero-alert-option')
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
    createElement(MessageView, { message: chatMessageToUIMessage(msg), onDiscuss: () => {} }),
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

  it('renders an interrupted response as a safe, redacted recovery message', () => {
    const html = renderMessage(makeMsg([
      { type: 'error', message: 'stderr: credentials=secret; monthly account limit reached' },
    ], 'assistant'))
    expect(html).toContain('role="alert"')
    expect(html).toContain('Response interrupted')
    expect(html).toContain('Send another message to try again.')
    expect(html).toContain('Try again')
    expect(html).not.toContain('credentials=secret')
    expect(html).not.toContain('monthly account limit')
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
