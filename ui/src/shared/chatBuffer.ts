/**
 * chatBuffer — module-level store for live chat segments streamed from the
 * daemon's `chat-delta` SSE events.
 *
 * `applyLiveEvent` is a pure reducer exported for unit testing. The module
 * also exposes `pushLiveEvent` / `clearLiveBuffer` for the SSE handler, and
 * `useLiveBuffer` for React components to subscribe via useSyncExternalStore.
 */
import { useSyncExternalStore } from 'react'

/**
 * A single streaming event from the daemon chat-runner. Mirrors the
 * `ChatSegment` union in `orchestrator/src/core/daemon/chat-runner.ts`.
 */
export type LiveEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; isError: boolean }
  | { type: 'result'; durationMs: number | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cost: number | null }
  | { type: 'error'; message: string }

/** Accumulated display state for a single thread's in-flight run. */
export type LiveBuffer = {
  /** Accumulated assistant text (all `text` segments concatenated). */
  text: string
  /** Last received thinking block text, or null if none yet. */
  thinking: string | null
  /** Name of the most recently started tool (cleared on tool_result). */
  currentTool: string | null
  /** Total number of tool_use events received. */
  toolCount: number
  /** Error message if a run-error segment was received. */
  error: string | null
  /** True once a `result` or `error` segment signals run completion. */
  done: boolean
}

const EMPTY: LiveBuffer = {
  text: '',
  thinking: null,
  currentTool: null,
  toolCount: 0,
  error: null,
  done: false,
}

/**
 * Pure reducer: apply one live event to an existing buffer snapshot.
 * Has no side effects — exported for unit testing.
 */
export function applyLiveEvent(buf: LiveBuffer, event: LiveEvent): LiveBuffer {
  switch (event.type) {
    case 'text':
      return { ...buf, text: buf.text + event.text }
    case 'thinking':
      return { ...buf, thinking: event.thinking }
    case 'tool_use':
      return { ...buf, currentTool: event.name, toolCount: buf.toolCount + 1 }
    case 'tool_result':
      // Tool result signals the tool completed — clear the "running" indicator.
      return { ...buf, currentTool: null }
    case 'result':
      return { ...buf, done: true, currentTool: null }
    case 'error':
      return { ...buf, error: event.message, done: true, currentTool: null }
    default:
      return buf
  }
}

// ── Module-level store ────────────────────────────────────────────────────────

const buffers = new Map<string, LiveBuffer>()
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const l of listeners) l()
}

/** Apply a live event for `threadId`, creating the buffer on first call. */
export function pushLiveEvent(threadId: string, event: LiveEvent): void {
  const current = buffers.get(threadId) ?? { ...EMPTY }
  buffers.set(threadId, applyLiveEvent(current, event))
  notify()
}

/**
 * Remove the live buffer for `threadId`. Call after persisted data has loaded
 * so the live view gives way to the stable persisted transcript.
 */
export function clearLiveBuffer(threadId: string): void {
  if (!buffers.has(threadId)) return
  buffers.delete(threadId)
  notify()
}

/** Read the current snapshot for `threadId`, or null when no run is active. */
export function getLiveBuffer(threadId: string): LiveBuffer | null {
  return buffers.get(threadId) ?? null
}

// ── React integration ─────────────────────────────────────────────────────────

const subscribeStore = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/**
 * React hook: subscribe to the live buffer for one thread.
 * Returns null when no run is active. Re-renders on every segment push.
 */
export function useLiveBuffer(threadId: string): LiveBuffer | null {
  return useSyncExternalStore(
    subscribeStore,
    () => getLiveBuffer(threadId),
    () => null,
  )
}
