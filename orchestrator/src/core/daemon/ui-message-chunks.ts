/**
 * ui-message-chunks — the server-side `ChatSegment -> UIMessageChunk` mapping.
 *
 * This is the DAEMON-SIDE twin of what used to live purely on the client in
 * `ui/src/shared/marsChatTransport.ts` (`onEvent`). The daemon now maps its own
 * chat-runner segments into the AI-SDK `UIMessageChunk` shape and streams them
 * over `GET /chat/threads/:id/ui-stream`; the client transport is a thin pipe.
 *
 * DELIBERATE BOUNDARY DUPLICATION (not a shim): the orchestrator has no `ai`
 * package (its `node_modules` is symlinked read-only), so the `UIMessageChunk`
 * union below is hand-rolled to mirror the exact subset of AI-SDK chunk shapes
 * Mars emits. Both ends are ours, so the wire contract is this explicit,
 * versioned JSON-lines-over-SSE format — NOT a byte-for-byte copy of AI-SDK's
 * internal DefaultChatTransport protocol. Keep this union in lockstep with the
 * `UIMessageChunk` types the client parses in `marsChatTransport.ts`.
 */

import { randomUUID } from 'node:crypto'
import type { ChatSegment } from './chat-runner'

/** Usage stats carried on the terminal `finish` chunk's `messageMetadata`. */
export interface UiMessageMetadata {
  /** Provider input + output tokens spent to produce this message. */
  turnTokens: number
  usage?: {
    durationMs: number | null
    inputTokens: number | null
    outputTokens: number | null
    cacheReadTokens: number | null
    cost: number | null
  }
}

/**
 * The minimal `UIMessageChunk` union Mars emits. Mirrors the objects the client
 * transport previously produced. Rendering (AI-SDK `useChat`) narrows on `type`.
 */
export type UiMessageChunk =
  | { type: 'start' }
  | { type: 'start-step' }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string }
  | { type: 'finish-step' }
  | { type: 'finish'; finishReason: 'stop' | 'error'; messageMetadata?: UiMessageMetadata }
  | { type: 'error'; errorText: string }

/** Render arbitrary tool-error content to a string for `errorText`. */
const stringifyError = (content: unknown): string => {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/**
 * A stateful folder that turns a run's `ChatSegment` stream into an ordered
 * `UIMessageChunk` stream. One instance per run (the open/close bookkeeping for
 * the current text block is per-run state). The chunk sequence it produces is
 * identical to the one the old client-side transport emitted, so history and
 * live render on the same `UIMessage.parts` shape.
 *
 * Usage:
 *   const m = new ChunkMapper()
 *   emit(...m.open())          // 'start', 'start-step'
 *   for (seg of segments) emit(...m.push(seg))
 *   emit(...m.close('stop'))   // terminal 'finish' iff not already terminated
 */
export class ChunkMapper {
  private textId: string | null = null
  private terminated = false

  /** The opening chunks of a run — emitted once before any segment. */
  open(): UiMessageChunk[] {
    return [{ type: 'start' }, { type: 'start-step' }]
  }

  /** True once a terminal `finish` chunk has been produced for this run. */
  isTerminated(): boolean {
    return this.terminated
  }

  private closeText(out: UiMessageChunk[]): void {
    if (this.textId !== null) {
      out.push({ type: 'text-end', id: this.textId })
      this.textId = null
    }
  }

  /** Fold one segment into zero or more chunks. */
  push(seg: ChatSegment): UiMessageChunk[] {
    if (this.terminated) return []
    const out: UiMessageChunk[] = []
    switch (seg.type) {
      case 'text': {
        if (seg.text.length === 0) break // drop empty text blocks
        if (this.textId === null) {
          this.textId = randomUUID()
          out.push({ type: 'text-start', id: this.textId })
        }
        out.push({ type: 'text-delta', id: this.textId, delta: seg.text })
        break
      }
      case 'thinking': {
        if (seg.thinking.length === 0) break // drop empty reasoning
        this.closeText(out)
        const rId = randomUUID()
        out.push({ type: 'reasoning-start', id: rId })
        out.push({ type: 'reasoning-delta', id: rId, delta: seg.thinking })
        out.push({ type: 'reasoning-end', id: rId })
        break
      }
      case 'tool_use': {
        out.push({ type: 'tool-input-start', toolCallId: seg.id, toolName: seg.name })
        out.push({ type: 'tool-input-available', toolCallId: seg.id, toolName: seg.name, input: seg.input })
        break
      }
      case 'tool_result': {
        // A tool result ends any open prose run before the tool panel resolves.
        this.closeText(out)
        if (seg.isError) {
          out.push({ type: 'tool-output-error', toolCallId: seg.tool_use_id, errorText: stringifyError(seg.content) })
        } else {
          out.push({ type: 'tool-output-available', toolCallId: seg.tool_use_id, output: seg.content })
        }
        break
      }
      case 'result': {
        this.closeText(out)
        out.push({ type: 'finish-step' })
        out.push({
          type: 'finish',
          finishReason: 'stop',
          messageMetadata: {
            turnTokens: Math.max(0, seg.inputTokens ?? 0) + Math.max(0, seg.outputTokens ?? 0),
            usage: {
              durationMs: seg.durationMs,
              inputTokens: seg.inputTokens,
              outputTokens: seg.outputTokens,
              cacheReadTokens: seg.cacheReadTokens,
              cost: seg.cost,
            },
          },
        })
        this.terminated = true
        break
      }
      case 'error': {
        this.closeText(out)
        out.push({ type: 'error', errorText: seg.message })
        out.push({ type: 'finish', finishReason: 'error', messageMetadata: { turnTokens: 0 } })
        this.terminated = true
        break
      }
      // 'attachment' segments are persisted on the user message, never streamed.
      case 'attachment':
        break
    }
    return out
  }

  /**
   * Seal the run. Emits a terminal `finish` (default reason `stop`) ONLY when
   * no `result`/`error` segment already terminated the run — e.g. a manual stop
   * that produced no result segment. Idempotent.
   */
  close(reason: 'stop' | 'error' = 'stop'): UiMessageChunk[] {
    if (this.terminated) return []
    const out: UiMessageChunk[] = []
    this.closeText(out)
    out.push({ type: 'finish', finishReason: reason, messageMetadata: { turnTokens: 0 } })
    this.terminated = true
    return out
  }
}
