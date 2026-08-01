/**
 * Shared, type-only contracts for the daemon chat stream.
 *
 * This module is intentionally a leaf: it describes the values exchanged by
 * the runner, chunk mapper, stream hub, and HTTP transport without importing
 * any of their runtime implementations.
 */

/** A single typed segment produced while a chat run is streamed. */
export type ChatSegment =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; tool: string; input: unknown; status?: 'executed' | 'proposed' | 'error' }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; isError: boolean }
  | { type: 'result'; durationMs: number | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cost: number | null }
  | { type: 'error'; message: string }
  | { type: 'attachment'; path: string; mimeType: string; name: string; size: number; kindHint: 'image' | 'audio' | 'video' }

/** Usage statistics carried on a terminal UI message chunk. */
export interface UiMessageMetadata {
  turnTokens: number
  usage?: {
    durationMs: number | null
    inputTokens: number | null
    outputTokens: number | null
    cacheReadTokens: number | null
    cost: number | null
  }
}

/** The subset of AI-SDK UI message chunks emitted by Mars. */
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

/** One buffered chunk, tagged with its run generation and per-run sequence. */
export interface SeqChunk {
  gen: number
  seq: number
  chunk: UiMessageChunk
}

/** Snapshot of a thread's current stream run. */
export interface RunSnapshot {
  gen: number
  buffer: SeqChunk[]
  active: boolean
}

/** Callbacks registered to receive live stream chunks for a thread. */
export interface ChatStreamSubscriber {
  onChunk: (chunk: SeqChunk) => void
  onEnd: () => void
}

/** Type-only surface the runner and HTTP transport need from the stream hub. */
export interface ChatStreamHub {
  startRun(threadId: string): void
  publish(threadId: string, segment: ChatSegment): void
  finishRun(threadId: string, reason?: 'stop' | 'error'): void
  snapshot(threadId: string): RunSnapshot | null
  subscribe(threadId: string, subscriber: ChatStreamSubscriber): () => void
}
