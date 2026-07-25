/**
 * chat-history — turns persisted `chat_messages` rows into the `input` array
 * the ChatGPT/Codex backend expects.
 *
 * WHY THIS EXISTS
 *
 * The Codex CLI held conversation state for us: `codex exec resume <sessionId>`
 * replayed the thread server-side, so the runner only ever sent the new user
 * message. The direct backend route cannot do that — it rejects `store: true`
 * outright (`{"detail":"Store must be set to false"}`), which also rules out
 * `previous_response_id` chaining. Every turn must therefore carry its own
 * history, rebuilt from the database.
 *
 * That makes history size the single biggest driver of both latency and quota
 * burn, so this module bounds it deliberately:
 *
 *  - Newest-first accumulation with an oldest-dropped-first character cap, so a
 *    long thread degrades by losing its distant past rather than by refusing to
 *    answer or silently blowing up the request.
 *  - Tool traffic is summarised, never replayed. A `tool_use` becomes
 *    `used tool mars task`; `tool_result`, `thinking`, and `result` segments are
 *    dropped entirely. Replaying raw command output is what makes naive
 *    client-side history grow quadratically over a tool-heavy thread.
 *  - `alert` segments are rendered as text so an alert-origin thread keeps the
 *    context the old preamble path injected.
 *
 * Rebuilding from the DB every turn also removes the session-loss failure mode:
 * there is no provider-side session left to expire when the daemon restarts.
 */

import type { ChatMessage } from '../lib/chat-store'
import type { AlertSegment } from '../lib/chat-store'

/** One conversation turn in Responses-API `input` shape. */
export interface ProviderInputItem {
  role: 'user' | 'assistant'
  content: { type: 'input_text' | 'output_text'; text: string }[]
}

/** Newest N messages considered for replay, before the character cap applies. */
const DEFAULT_MAX_MESSAGES = 30

/**
 * Character budget for the whole replayed history.
 *
 * Roughly 6 k tokens at ~4 chars/token — large enough that a normal working
 * conversation replays whole, small enough that a runaway thread cannot push
 * the request into multi-second prefill on every keystroke.
 */
const DEFAULT_MAX_CHARS = 24_000

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Flatten one message's segments into replayable text.
 *
 * Falls back to `msg.content` when the row has no structured segments (older
 * rows, or user messages persisted before segments existed).
 */
export const flattenMessageText = (msg: ChatMessage): string => {
  const segs = Array.isArray(msg.segments) ? (msg.segments as unknown[]) : []
  if (segs.length === 0) return msg.content

  const parts: string[] = []
  for (const seg of segs) {
    if (!isObject(seg)) continue
    if (seg.type === 'text' && typeof seg.text === 'string') {
      parts.push(seg.text)
    } else if (seg.type === 'tool_use') {
      // Name only — the arguments and output are deliberately not replayed.
      const name =
        typeof seg.name === 'string'
          ? seg.name
          : typeof seg.toolName === 'string'
            ? seg.toolName
            : 'unknown'
      parts.push(`used tool ${name}`)
    } else if (seg.type === 'alert') {
      const alert = seg as unknown as AlertSegment
      const lines = [`[Alert: ${alert.kind}] ${alert.title}`, `Why now: ${alert.whyNow}`]
      const actions = alert.actions.map((a) => a.label).join(', ')
      if (actions) lines.push(`Available actions: ${actions}`)
      parts.push(lines.join('\n'))
    }
    // thinking / tool_result / result / attachment → dropped: noisy, and
    // replaying them is what makes history grow superlinearly.
  }
  return parts.join(' ')
}

/**
 * Build the bounded `input` array for a chat turn.
 *
 * `messages` is the thread's full persisted history in chronological order
 * (as `getThread` returns it). The newest messages are kept; older ones are
 * dropped once the character cap is reached. The returned array is
 * chronological so the model reads the conversation in order.
 *
 * The caller appends the current user prompt after this — it is never part of
 * `messages` yet at the point this runs, and must never be dropped by the cap.
 */
export const buildProviderHistory = (
  messages: readonly ChatMessage[],
  options: { maxMessages?: number; maxChars?: number } = {},
): ProviderInputItem[] => {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS

  const candidates = messages.slice(-maxMessages)
  const kept: ProviderInputItem[] = []
  let charCount = 0

  // Walk newest → oldest so the cap sheds the distant past, not recent context.
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const msg = candidates[i]
    if (!msg) continue
    const text = flattenMessageText(msg).trim()
    if (text.length === 0) continue
    if (charCount + text.length > maxChars) break
    charCount += text.length
    kept.push({
      role: msg.role,
      content: [{ type: msg.role === 'assistant' ? 'output_text' : 'input_text', text }],
    })
  }

  return kept.reverse()
}

/**
 * Split a trailing user turn off the end of a history array.
 *
 * The turn being sent is always supplied separately as the prompt, so a user
 * turn at the end of the replayed history means one of two things:
 *
 *  - a retry (throttle backoff, or the re-queue after re-authentication) whose
 *    user message was already persisted on the first attempt — replaying it
 *    *and* sending the prompt would duplicate it; or
 *  - a re-queue that carries no prompt of its own, in which case the popped
 *    text IS the message to send.
 *
 * Returns the history with trailing user turns removed and the text of the last
 * one, so callers can cover both cases with one call.
 */
export const splitTrailingUserTurn = (
  history: readonly ProviderInputItem[],
): { history: ProviderInputItem[]; trailingUserText: string | null } => {
  const kept = [...history]
  let trailingUserText: string | null = null
  while (kept.length > 0 && kept[kept.length - 1]?.role === 'user') {
    const popped = kept.pop()
    if (trailingUserText === null && popped) {
      trailingUserText = popped.content.map((c) => c.text).join('\n')
    }
  }
  return { history: kept, trailingUserText }
}
