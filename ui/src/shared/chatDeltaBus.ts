/**
 * chatDeltaBus — a tiny per-thread pub/sub for daemon `chat-delta` events.
 *
 * The single global `EventSource` in `SseInvalidator` parses each `chat-delta`
 * SSE frame and `publishChatDelta(threadId, event)`s it here. The AI-SDK
 * transport (`marsChatTransport.ts`) `subscribeChatDelta(threadId, cb)`s to the
 * thread it is bound to, demultiplexing by `threadId` — no second stream is
 * opened.
 *
 * This replaces the accumulating `chatBuffer` store: the bus forwards raw
 * events (it holds no state); the transport owns the per-run normalisation into
 * `UIMessageChunk`s.
 */
import type { LiveEvent } from './liveEvent'

type Sub = (event: LiveEvent) => void

const subs = new Map<string, Set<Sub>>()

/** Forward one live event to every subscriber of `threadId`. No-op if none. */
export function publishChatDelta(threadId: string, event: LiveEvent): void {
  const set = subs.get(threadId)
  if (!set) return
  // Snapshot so an unsubscribe during iteration cannot skip a listener.
  for (const cb of [...set]) cb(event)
}

/**
 * Subscribe to `threadId`'s live events. Returns an unsubscribe function that
 * removes this listener and prunes the thread's bucket when it empties.
 */
export function subscribeChatDelta(threadId: string, cb: Sub): () => void {
  let set = subs.get(threadId)
  if (!set) {
    set = new Set()
    subs.set(threadId, set)
  }
  set.add(cb)
  return () => {
    const current = subs.get(threadId)
    if (!current) return
    current.delete(cb)
    if (current.size === 0) subs.delete(threadId)
  }
}
