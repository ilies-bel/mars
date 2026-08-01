/**
 * chat-stream-hub — the per-thread source the `GET /chat/threads/:id/ui-stream`
 * route subscribes to.
 *
 * The chat-runner publishes each `ChatSegment` here as it streams; the hub folds
 * it into `UIMessageChunk`s (via {@link ChunkMapper}), buffers them with a
 * monotonic `(gen, seq)` id, and fans them to live subscribers. The buffer is
 * what makes the stream RESUMABLE: a client that (re)connects replays the
 * buffered chunks it has not seen (by `lastEventId`), then follows live output.
 *
 * One run per thread at a time (the chat-runner enforces this). `startRun`
 * bumps the generation and clears the buffer; `finishRun` seals it. A sealed
 * run's buffer is retained until the next `startRun` supersedes it, so a late
 * reconnect for a just-finished run still replays the whole reply.
 */

import { ChunkMapper } from './ui-message-chunks'
import type {
  ChatSegment,
  ChatStreamHub as ChatStreamHubContract,
  ChatStreamSubscriber,
  RunSnapshot,
  SeqChunk,
  UiMessageChunk,
} from './chat-contracts'

interface ThreadRun {
  gen: number
  mapper: ChunkMapper
  buffer: SeqChunk[]
  /** True while the run is streaming; false once sealed. */
  active: boolean
}

export class ChatStreamHub implements ChatStreamHubContract {
  private runs = new Map<string, ThreadRun>()
  private subs = new Map<string, Set<ChatStreamSubscriber>>()
  private genCounter = 0

  /**
   * Begin a fresh run for `threadId`: bump the generation, reset the buffer and
   * mapper, and seed the opening `start` / `start-step` chunks. Any subscriber
   * already attached (send-mode connected before the run started) receives the
   * seeded chunks live.
   */
  startRun(threadId: string): void {
    this.genCounter += 1
    const mapper = new ChunkMapper()
    const run: ThreadRun = { gen: this.genCounter, mapper, buffer: [], active: true }
    this.runs.set(threadId, run)
    for (const chunk of mapper.open()) this.append(threadId, run, chunk)
  }

  /** Fold one segment into chunks, buffer them, and fan them to subscribers. */
  publish(threadId: string, seg: ChatSegment): void {
    const run = this.runs.get(threadId)
    if (!run) return
    for (const chunk of run.mapper.push(seg)) this.append(threadId, run, chunk)
  }

  /**
   * Seal the run. Emits a terminal `finish` (reason `stop`) when no
   * `result`/`error` segment already terminated the mapper — covering a manual
   * stop. Notifies subscribers via `onEnd` so they can close their SSE.
   */
  finishRun(threadId: string, reason: 'stop' | 'error' = 'stop'): void {
    const run = this.runs.get(threadId)
    if (!run || !run.active) return
    for (const chunk of run.mapper.close(reason)) this.append(threadId, run, chunk)
    run.active = false
    const set = this.subs.get(threadId)
    if (set) for (const sub of [...set]) sub.onEnd()
  }

  /** Current run snapshot for `threadId`, or null when no run has started. */
  snapshot(threadId: string): RunSnapshot | null {
    const run = this.runs.get(threadId)
    if (!run) return null
    return { gen: run.gen, buffer: run.buffer, active: run.active }
  }

  /**
   * Register a live subscriber for `threadId`. Only NEW chunks (published after
   * this call) are delivered; the caller is responsible for replaying the
   * current snapshot buffer first. Returns an unsubscribe function.
   */
  subscribe(threadId: string, sub: ChatStreamSubscriber): () => void {
    let set = this.subs.get(threadId)
    if (!set) {
      set = new Set()
      this.subs.set(threadId, set)
    }
    set.add(sub)
    return () => {
      const current = this.subs.get(threadId)
      if (!current) return
      current.delete(sub)
      if (current.size === 0) this.subs.delete(threadId)
    }
  }

  private append(threadId: string, run: ThreadRun, chunk: UiMessageChunk): void {
    const seqChunk: SeqChunk = { gen: run.gen, seq: run.buffer.length, chunk }
    run.buffer.push(seqChunk)
    const set = this.subs.get(threadId)
    if (set) for (const sub of [...set]) sub.onChunk(seqChunk)
  }
}
