/**
 * Unit tests for the server-side ChatSegment -> UIMessageChunk mapper.
 *
 * This is the daemon-side twin of the mapping that used to live in the client
 * transport (`marsChatTransport.ts` `onEvent`). The chunk sequence it produces
 * MUST match what the client used to emit so history and live render identically.
 */
import { describe, it, expect } from 'vitest'
import { ChunkMapper, type UiMessageChunk } from '../ui-message-chunks'
import type { ChatSegment } from '../chat-runner'

const types = (chunks: UiMessageChunk[]): string[] => chunks.map((c) => c.type)

describe('ChunkMapper.open', () => {
  it('emits start then start-step', () => {
    expect(new ChunkMapper().open()).toEqual([{ type: 'start' }, { type: 'start-step' }])
  })
})

describe('ChunkMapper.push', () => {
  it('opens a text block once, then streams deltas', () => {
    const m = new ChunkMapper()
    const first = m.push({ type: 'text', text: 'Hello' })
    expect(types(first)).toEqual(['text-start', 'text-delta'])
    const second = m.push({ type: 'text', text: ' world' })
    // No second text-start — the block is already open.
    expect(types(second)).toEqual(['text-delta'])
    expect((second[0] as Extract<UiMessageChunk, { type: 'text-delta' }>).delta).toBe(' world')
    // Both deltas share one text id.
    const id0 = (first[0] as Extract<UiMessageChunk, { type: 'text-start' }>).id
    const id1 = (second[0] as Extract<UiMessageChunk, { type: 'text-delta' }>).id
    expect(id1).toBe(id0)
  })

  it('drops empty text segments', () => {
    expect(new ChunkMapper().push({ type: 'text', text: '' })).toEqual([])
  })

  it('maps thinking to a self-contained reasoning triple, closing open text first', () => {
    const m = new ChunkMapper()
    m.push({ type: 'text', text: 'before' })
    const out = m.push({ type: 'thinking', thinking: 'pondering' })
    expect(types(out)).toEqual(['text-end', 'reasoning-start', 'reasoning-delta', 'reasoning-end'])
  })

  it('drops empty thinking segments', () => {
    expect(new ChunkMapper().push({ type: 'thinking', thinking: '' })).toEqual([])
  })

  it('maps tool_use to tool-input-start + tool-input-available', () => {
    const m = new ChunkMapper()
    const out = m.push({ type: 'tool_use', id: 'c1', name: 'ls', tool: 'shell', input: { command: 'ls' } })
    expect(out).toEqual([
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'ls' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'ls', input: { command: 'ls' } },
    ])
  })

  it('maps a successful tool_result to tool-output-available (closing text)', () => {
    const m = new ChunkMapper()
    m.push({ type: 'text', text: 'x' })
    const out = m.push({ type: 'tool_result', tool_use_id: 'c1', content: { stdout: 'ok' }, isError: false })
    expect(types(out)).toEqual(['text-end', 'tool-output-available'])
    expect(out[1]).toEqual({ type: 'tool-output-available', toolCallId: 'c1', output: { stdout: 'ok' } })
  })

  it('maps an errored tool_result to tool-output-error with a stringified body', () => {
    const m = new ChunkMapper()
    const out = m.push({ type: 'tool_result', tool_use_id: 'c2', content: { stderr: 'boom' }, isError: true })
    expect(out).toEqual([{ type: 'tool-output-error', toolCallId: 'c2', errorText: JSON.stringify({ stderr: 'boom' }) }])
  })

  it('maps result to finish-step + finish carrying usage metadata, and terminates', () => {
    const m = new ChunkMapper()
    const seg: ChatSegment = { type: 'result', durationMs: 12, inputTokens: 5, outputTokens: 3, cacheReadTokens: 1, cost: 0.01 }
    const out = m.push(seg)
    expect(types(out)).toEqual(['finish-step', 'finish'])
    expect(out[1]).toEqual({
      type: 'finish',
      finishReason: 'stop',
      messageMetadata: { turnTokens: 8, usage: { durationMs: 12, inputTokens: 5, outputTokens: 3, cacheReadTokens: 1, cost: 0.01 } },
    })
    expect(m.isTerminated()).toBe(true)
    // Nothing streams after termination.
    expect(m.push({ type: 'text', text: 'late' })).toEqual([])
  })

  it('includes the provider turn total in terminal metadata', () => {
    const out = new ChunkMapper().push({
      type: 'result', durationMs: null, inputTokens: 12, outputTokens: 8, cacheReadTokens: null, cost: null,
    })

    expect(out[1]).toMatchObject({ type: 'finish', messageMetadata: { turnTokens: 20 } })
  })

  it('maps error to an error chunk + finish(error) and terminates', () => {
    const m = new ChunkMapper()
    const out = m.push({ type: 'error', message: 'nope' })
    expect(out).toEqual([{ type: 'error', errorText: 'nope' }, { type: 'finish', finishReason: 'error', messageMetadata: { turnTokens: 0 } }])
    expect(m.isTerminated()).toBe(true)
  })

  it('does not stream attachment segments', () => {
    const seg: ChatSegment = { type: 'attachment', path: '/a.png', mimeType: 'image/png', name: 'a', size: 1, kindHint: 'image' }
    expect(new ChunkMapper().push(seg)).toEqual([])
  })
})

describe('ChunkMapper.close', () => {
  it('emits a terminal finish(stop) for a bare stop with no result', () => {
    const m = new ChunkMapper()
    m.push({ type: 'text', text: 'partial' })
    const out = m.close()
    expect(types(out)).toEqual(['text-end', 'finish'])
    expect(out[1]).toEqual({ type: 'finish', finishReason: 'stop', messageMetadata: { turnTokens: 0 } })
  })

  it('is a no-op once a result already terminated the run', () => {
    const m = new ChunkMapper()
    m.push({ type: 'result', durationMs: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cost: null })
    expect(m.close()).toEqual([])
  })
})
