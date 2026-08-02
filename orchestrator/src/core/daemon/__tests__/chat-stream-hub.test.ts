/**
 * Unit tests for ChatStreamHub — the per-thread UIMessageChunk source backing
 * GET /chat/threads/:id/ui-stream. Covers buffering + sequencing, live fan-out,
 * snapshot/replay (the resume primitive), run sealing, and generation bumping.
 */
import { describe, it, expect } from 'vitest'
import { ChatStreamHub } from '../chat-stream-hub'
import type { SeqChunk, UiMessageChunk } from '../chat-contracts'

const chunkTypes = (scs: SeqChunk[]): string[] => scs.map((s) => s.chunk.type)

describe('ChatStreamHub buffering + sequencing', () => {
  it('seeds start/start-step into the buffer on startRun with sequential seq', () => {
    const hub = new ChatStreamHub()
    hub.startRun('t1')
    const snap = hub.snapshot('t1')!
    expect(snap.active).toBe(true)
    expect(chunkTypes(snap.buffer)).toEqual(['start', 'start-step'])
    expect(snap.buffer.map((s) => s.seq)).toEqual([0, 1])
    // All chunks share the run generation.
    expect(new Set(snap.buffer.map((s) => s.gen)).size).toBe(1)
  })

  it('appends mapped chunks for each published segment', () => {
    const hub = new ChatStreamHub()
    hub.startRun('t1')
    hub.publish('t1', { type: 'text', text: 'hi' })
    const snap = hub.snapshot('t1')!
    expect(chunkTypes(snap.buffer)).toEqual(['start', 'start-step', 'text-start', 'text-delta'])
    expect(snap.buffer.map((s) => s.seq)).toEqual([0, 1, 2, 3])
  })

  it('returns null snapshot for a thread that never ran', () => {
    expect(new ChatStreamHub().snapshot('nope')).toBeNull()
  })
})

describe('ChatStreamHub live fan-out', () => {
  it('delivers only chunks published AFTER subscription', () => {
    const hub = new ChatStreamHub()
    hub.startRun('t1') // start/start-step buffered before we subscribe
    const live: UiMessageChunk[] = []
    hub.subscribe('t1', { onChunk: (sc) => live.push(sc.chunk), onEnd: () => {} })
    hub.publish('t1', { type: 'text', text: 'x' })
    // Only the post-subscribe chunks arrive live; the buffer is for replay.
    expect(live.map((c) => c.type)).toEqual(['text-start', 'text-delta'])
  })

  it('fires onEnd exactly once when the run seals', () => {
    const hub = new ChatStreamHub()
    hub.startRun('t1')
    let ends = 0
    hub.subscribe('t1', { onChunk: () => {}, onEnd: () => { ends += 1 } })
    hub.finishRun('t1')
    hub.finishRun('t1') // second call is a no-op (already sealed)
    expect(ends).toBe(1)
  })

  it('stops delivering after unsubscribe', () => {
    const hub = new ChatStreamHub()
    hub.startRun('t1')
    const live: UiMessageChunk[] = []
    const off = hub.subscribe('t1', { onChunk: (sc) => live.push(sc.chunk), onEnd: () => {} })
    hub.publish('t1', { type: 'text', text: 'a' })
    off()
    hub.publish('t1', { type: 'text', text: 'b' })
    expect(live.filter((c) => c.type === 'text-delta').length).toBe(1)
  })

  it('isolates subscribers by threadId', () => {
    const hub = new ChatStreamHub()
    hub.startRun('ta')
    hub.startRun('tb')
    const a: UiMessageChunk[] = []
    hub.subscribe('ta', { onChunk: (sc) => a.push(sc.chunk), onEnd: () => {} })
    hub.publish('tb', { type: 'text', text: 'for-b' })
    expect(a).toEqual([])
  })
})

describe('ChatStreamHub sealing', () => {
  it('emits a terminal finish(stop) when no result segment terminated the run', () => {
    const hub = new ChatStreamHub()
    hub.startRun('t1')
    hub.publish('t1', { type: 'text', text: 'partial' })
    hub.finishRun('t1')
    const snap = hub.snapshot('t1')!
    expect(snap.active).toBe(false)
    expect(snap.buffer.at(-1)!.chunk).toMatchObject({ type: 'finish', finishReason: 'stop' })
  })

  it('does not double-emit finish when a result segment already terminated', () => {
    const hub = new ChatStreamHub()
    hub.startRun('t1')
    hub.publish('t1', { type: 'result', durationMs: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cost: null })
    hub.finishRun('t1')
    const finishes = hub.snapshot('t1')!.buffer.filter((s) => s.chunk.type === 'finish')
    expect(finishes.length).toBe(1)
  })
})

describe('ChatStreamHub generations (resume correctness)', () => {
  it('bumps generation and resets the buffer on a new run, so seq cursors do not collide', () => {
    const hub = new ChatStreamHub()
    hub.startRun('t1')
    hub.publish('t1', { type: 'text', text: 'run-one' })
    const gen1 = hub.snapshot('t1')!.gen

    hub.startRun('t1') // supersede
    const snap2 = hub.snapshot('t1')!
    expect(snap2.gen).toBeGreaterThan(gen1)
    // Fresh buffer, seq restarts at 0.
    expect(chunkTypes(snap2.buffer)).toEqual(['start', 'start-step'])
    expect(snap2.buffer.map((s) => s.seq)).toEqual([0, 1])
  })

  it('a sealed run buffer is retained until the next startRun (late-reconnect replay)', () => {
    const hub = new ChatStreamHub()
    hub.startRun('t1')
    hub.publish('t1', { type: 'result', durationMs: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cost: null })
    hub.finishRun('t1')
    // A late subscriber can still replay the whole finished reply from snapshot.
    const snap = hub.snapshot('t1')!
    expect(snap.active).toBe(false)
    expect(chunkTypes(snap.buffer)).toContain('finish')
  })
})
