/**
 * Unit tests for the per-thread chat-delta pub/sub bus.
 *
 * The bus replaced the accumulating `chatBuffer` store: it holds no state and
 * only fans a raw `LiveEvent` out to the subscribers of a given `threadId`. The
 * `MarsChatTransport` is the sole subscriber in production; here we verify the
 * observable subscribe / publish / unsubscribe + threadId-isolation contract.
 */
import { describe, it, expect } from 'bun:test'
import { publishChatDelta, subscribeChatDelta } from './chatDeltaBus'
import type { LiveEvent } from './liveEvent'

const textEvent = (text: string): LiveEvent => ({ type: 'text', text })

describe('chatDeltaBus', () => {
  it('delivers a published event to a subscriber of the same thread', () => {
    const received: LiveEvent[] = []
    const off = subscribeChatDelta('t1', (e) => received.push(e))
    publishChatDelta('t1', textEvent('hi'))
    off()
    expect(received).toEqual([textEvent('hi')])
  })

  it('stops delivering after unsubscribe', () => {
    const received: LiveEvent[] = []
    const off = subscribeChatDelta('t2', (e) => received.push(e))
    publishChatDelta('t2', textEvent('one'))
    off()
    publishChatDelta('t2', textEvent('two'))
    expect(received).toEqual([textEvent('one')])
  })

  it('isolates events by threadId', () => {
    const a: LiveEvent[] = []
    const b: LiveEvent[] = []
    const offA = subscribeChatDelta('ta', (e) => a.push(e))
    const offB = subscribeChatDelta('tb', (e) => b.push(e))
    publishChatDelta('ta', textEvent('for-a'))
    offA()
    offB()
    expect(a).toEqual([textEvent('for-a')])
    expect(b).toEqual([])
  })

  it('publishing to a thread with no subscribers is a no-op', () => {
    expect(() => publishChatDelta('nobody', textEvent('void'))).not.toThrow()
  })

  it('fans out to every subscriber of the thread', () => {
    let n = 0
    const off1 = subscribeChatDelta('multi', () => { n += 1 })
    const off2 = subscribeChatDelta('multi', () => { n += 1 })
    publishChatDelta('multi', textEvent('x'))
    off1()
    off2()
    expect(n).toBe(2)
  })

  it('an unsubscribe during publish does not skip the remaining subscriber', () => {
    const seen: string[] = []
    let off2: () => void = () => {}
    const off1 = subscribeChatDelta('reentrant', () => {
      seen.push('one')
      off2() // remove the second subscriber mid-iteration
    })
    off2 = subscribeChatDelta('reentrant', () => {
      seen.push('two')
    })
    publishChatDelta('reentrant', textEvent('x'))
    off1()
    // The snapshot taken at publish time means 'two' still fires this round.
    expect(seen).toEqual(['one', 'two'])
  })
})
