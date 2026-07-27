/**
 * activityFeed.test.ts — unit tests for buildActivityFeed.
 *
 * Covers the four acceptance-criteria cases:
 *   (a) live-only feed while streaming
 *   (b) mixed live+persisted after first tool completes
 *   (c) frozen persisted feed after stream ends
 *   (d) 8-item cap
 */

import { describe, it, expect } from 'bun:test'
import { buildActivityFeed } from './activityFeed'
import { emptyLiveBuffer, applyLiveEvent } from '@/shared/chatBuffer'
import type { LiveBuffer } from '@/shared/chatBuffer'
import type { ChatThreadDetail } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal ChatThreadDetail with tool_use segments in a single message. */
function makeThreadDetail(
  tools: Array<{ name: string; id: string }>,
): ChatThreadDetail {
  return {
    thread: {
      id: 'thread-fixture',
      title: 'Fixture thread',
      status: 'idle',
      attentionStatus: 'idle',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      messageCount: 1,
      origin: null,
      alertItemId: null,
      alertResolved: false,
    },
    messages: [
      {
        id: 'msg-fixture',
        threadId: 'thread-fixture',
        role: 'assistant',
        segments: tools.map((t) => ({
          type: 'tool_use' as const,
          id: t.id,
          toolName: t.name,
          input: { fixture: true },
          status: 'complete' as const,
          isError: false,
        })),
        createdAt: '2024-01-01T00:00:00.000Z',
        feedback: null,
      },
    ],
  }
}

/**
 * Build a LiveBuffer with the given tool calls applied in order.
 * Optionally advance each tool to `input-available` or `output-available`.
 */
function makeLiveBuffer(
  tools: Array<{
    id: string
    name: string
    state?: 'input-streaming' | 'input-available' | 'output-available'
  }>,
): LiveBuffer {
  return tools.reduce<LiveBuffer>((buf, tool) => {
    let b = applyLiveEvent(buf, {
      type: 'tool_use',
      toolUseId: tool.id,
      toolName: tool.name,
      input: { live: true },
    })
    if (tool.state === 'input-available' || tool.state === 'output-available') {
      b = applyLiveEvent(b, { type: 'tool_input_available', toolUseId: tool.id })
    }
    if (tool.state === 'output-available') {
      b = applyLiveEvent(b, {
        type: 'tool_result',
        toolUseId: tool.id,
        output: 'done',
      })
    }
    return b
  }, emptyLiveBuffer())
}

// ---------------------------------------------------------------------------
// (a) live-only feed while streaming
// ---------------------------------------------------------------------------

describe('buildActivityFeed – (a) live-only feed while streaming', () => {
  it('returns live entries from liveBuffer when isStreaming=true', () => {
    const buf = makeLiveBuffer([
      { id: 'tu-1', name: 'Bash' },
      { id: 'tu-2', name: 'Read' },
    ])
    const feed = buildActivityFeed(null, buf, true)
    expect(feed).toHaveLength(2)
    expect(feed.every((e) => e.state === 'live')).toBe(true)
  })

  it('records the correct tool names from the live buffer', () => {
    const buf = makeLiveBuffer([{ id: 'tu-bash', name: 'Bash' }])
    const feed = buildActivityFeed(null, buf, true)
    expect(feed[0]!.toolName).toBe('Bash')
  })

  it('returns an empty feed when liveBuffer has no tool groups', () => {
    const buf = applyLiveEvent(emptyLiveBuffer(), { type: 'text', text: 'hello' })
    const feed = buildActivityFeed(null, buf, true)
    expect(feed).toHaveLength(0)
  })

  it('orders entries most-recent first (last tool call is at index 0)', () => {
    const buf = makeLiveBuffer([
      { id: 'tu-first', name: 'Bash' },
      { id: 'tu-last', name: 'Write' },
    ])
    const feed = buildActivityFeed(null, buf, true)
    expect(feed[0]!.toolName).toBe('Write')
    expect(feed[1]!.toolName).toBe('Bash')
  })

  it('ignores liveBuffer when isStreaming=false', () => {
    const buf = makeLiveBuffer([{ id: 'tu-1', name: 'Bash' }])
    const feed = buildActivityFeed(null, buf, false)
    expect(feed).toHaveLength(0)
  })

  it('each live entry has state="live"', () => {
    const buf = makeLiveBuffer([
      { id: 'tu-a', name: 'ToolA' },
      { id: 'tu-b', name: 'ToolB' },
    ])
    const feed = buildActivityFeed(null, buf, true)
    for (const entry of feed) {
      expect(entry.state).toBe('live')
    }
  })
})

// ---------------------------------------------------------------------------
// (b) mixed live+persisted after first tool completes
// ---------------------------------------------------------------------------

describe('buildActivityFeed – (b) mixed live+persisted after first tool completes', () => {
  it('shows live entry from liveBuffer and persisted entry from threadDetail', () => {
    const threadDetail = makeThreadDetail([{ name: 'OldTool', id: 'tu-old' }])
    const buf = makeLiveBuffer([
      { id: 'tu-new', name: 'Bash', state: 'output-available' },
    ])
    const feed = buildActivityFeed(threadDetail, buf, true)
    expect(feed.some((e) => e.state === 'live' && e.toolName === 'Bash')).toBe(true)
    expect(feed.some((e) => e.state === 'persisted' && e.toolName === 'OldTool')).toBe(true)
  })

  it('live entries appear before persisted entries', () => {
    const threadDetail = makeThreadDetail([{ name: 'OldTool', id: 'tu-old' }])
    const buf = makeLiveBuffer([{ id: 'tu-live', name: 'LiveTool' }])
    const feed = buildActivityFeed(threadDetail, buf, true)
    const liveIdx = feed.findIndex((e) => e.state === 'live')
    const persistedIdx = feed.findIndex((e) => e.state === 'persisted')
    expect(liveIdx).toBeGreaterThanOrEqual(0)
    expect(persistedIdx).toBeGreaterThanOrEqual(0)
    expect(liveIdx).toBeLessThan(persistedIdx)
  })

  it('a completed tool still shows as live while isStreaming=true', () => {
    const buf = makeLiveBuffer([
      { id: 'tu-done', name: 'Bash', state: 'output-available' },
    ])
    const feed = buildActivityFeed(null, buf, true)
    expect(feed[0]!.state).toBe('live')
    expect(feed[0]!.toolName).toBe('Bash')
  })

  it('does not duplicate an entry that appears in both live buffer and threadDetail', () => {
    // Simulate a tool whose id appears in both sources.
    const threadDetail = makeThreadDetail([{ name: 'Bash', id: 'tu-shared' }])
    const buf = makeLiveBuffer([{ id: 'tu-shared', name: 'Bash' }])
    const feed = buildActivityFeed(threadDetail, buf, true)
    const shared = feed.filter((e) => e.id === 'tu-shared')
    expect(shared).toHaveLength(1)
    // The live entry takes precedence.
    expect(shared[0]!.state).toBe('live')
  })
})

// ---------------------------------------------------------------------------
// (c) frozen persisted feed after stream ends
// ---------------------------------------------------------------------------

describe('buildActivityFeed – (c) frozen persisted feed after stream ends', () => {
  it('returns only persisted entries when isStreaming=false', () => {
    const threadDetail = makeThreadDetail([
      { name: 'ToolA', id: 'tu-a' },
      { name: 'ToolB', id: 'tu-b' },
    ])
    const buf = makeLiveBuffer([{ id: 'tu-live', name: 'LiveTool' }])
    const feed = buildActivityFeed(threadDetail, buf, false)
    expect(feed.every((e) => e.state === 'persisted')).toBe(true)
    expect(feed.some((e) => e.toolName === 'ToolA')).toBe(true)
    expect(feed.some((e) => e.toolName === 'ToolB')).toBe(true)
  })

  it('returns an empty feed when threadDetail is null and not streaming', () => {
    const feed = buildActivityFeed(null, null, false)
    expect(feed).toHaveLength(0)
  })

  it('returns an empty feed when threadDetail has no messages', () => {
    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-empty',
        title: null,
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 0,
        origin: null,
        alertItemId: null,
        alertResolved: false,
      },
      messages: [],
    }
    const feed = buildActivityFeed(threadDetail, null, false)
    expect(feed).toHaveLength(0)
  })

  it('ignores non-tool_use segments in persisted messages', () => {
    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-text',
        title: null,
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 1,
        origin: null,
        alertItemId: null,
        alertResolved: false,
      },
      messages: [
        {
          id: 'msg-text',
          threadId: 'thread-text',
          role: 'assistant',
          segments: [{ type: 'text', text: 'Hello world' }],
          createdAt: '2024-01-01T00:00:00.000Z',
          feedback: null,
        },
      ],
    }
    const feed = buildActivityFeed(threadDetail, null, false)
    expect(feed).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// (d) 8-item cap
// ---------------------------------------------------------------------------

describe('buildActivityFeed – (d) 8-item cap', () => {
  it('caps the feed at 8 entries when more live tools are in the buffer', () => {
    const buf = makeLiveBuffer(
      Array.from({ length: 10 }, (_, i) => ({ id: `tu-${i}`, name: `Tool${i}` })),
    )
    const feed = buildActivityFeed(null, buf, true)
    expect(feed).toHaveLength(8)
  })

  it('caps the feed at 8 entries when combining live and persisted', () => {
    // 5 live + 6 persisted = 11 total; cap at 8.
    const buf = makeLiveBuffer(
      Array.from({ length: 5 }, (_, i) => ({ id: `tu-live-${i}`, name: `Live${i}` })),
    )
    const threadDetail = makeThreadDetail(
      Array.from({ length: 6 }, (_, i) => ({ name: `Persisted${i}`, id: `tu-p-${i}` })),
    )
    const feed = buildActivityFeed(threadDetail, buf, true)
    expect(feed).toHaveLength(8)
  })

  it('returns fewer than 8 entries when fewer tools exist', () => {
    const buf = makeLiveBuffer([{ id: 'tu-1', name: 'Bash' }])
    const feed = buildActivityFeed(null, buf, true)
    expect(feed.length).toBeLessThanOrEqual(8)
    expect(feed).toHaveLength(1)
  })
})
