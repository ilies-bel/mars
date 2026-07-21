/**
 * liveEvent — the SSE wire type for the daemon's `chat-delta` events.
 *
 * A single streaming event from the daemon chat-runner. Mirrors the
 * `ChatSegment` union in `orchestrator/src/core/daemon/chat-runner.ts`.
 *
 * This is the authoritative home for the `LiveEvent` union. The delta bus
 * (`chatDeltaBus.ts`) transports it; the AI-SDK transport
 * (`marsChatTransport.ts`) is the single normaliser that folds it into a
 * `UIMessageChunk` stream.
 */
export type LiveEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; isError: boolean }
  | {
      type: 'result'
      durationMs: number | null
      inputTokens: number | null
      outputTokens: number | null
      cacheReadTokens: number | null
      cost: number | null
    }
  | { type: 'error'; message: string }
