/**
 * Query helper for loading rated chat feedback entries from the Mars state
 * database, paired with the preceding user message and assistant reply.
 *
 * Each entry carries the full context needed by the reflector: the user's
 * prompt, the assistant's reply, the rating, and which tools the reply used.
 *
 * Text fields are truncated to TRUNCATE_CHARS characters with an ellipsis
 * marker so the reflect synthesis prompt cannot blow up on long conversations.
 *
 * The query is a single SQL statement with a JOIN (to the assistant message)
 * and a correlated subquery (for the most recent preceding user message in
 * the same thread). No per-row round trips.
 */

import { resolveStateClient } from '../store/state-client'
import type { DbInValue } from './db.js'

const TRUNCATE_CHARS = 1500
const stateClient = resolveStateClient

const truncateText = (s: string): string =>
  s.length > TRUNCATE_CHARS ? `${s.slice(0, TRUNCATE_CHARS)}…` : s

const extractToolsUsed = (segmentsRaw: string | null): string[] => {
  if (!segmentsRaw) return []
  try {
    const segs = JSON.parse(segmentsRaw) as unknown[]
    return segs
      .filter(
        (s): s is Record<string, unknown> =>
          s !== null && typeof s === 'object' && !Array.isArray(s),
      )
      .filter((s) => s['type'] === 'tool_use' && typeof s['name'] === 'string')
      .map((s) => s['name'] as string)
  } catch {
    return []
  }
}

export interface ChatFeedbackEntry {
  messageId: string
  threadId: string
  rating: 'up' | 'down'
  note: string | null
  createdAt: number
  /** The user message immediately preceding the rated reply, truncated to 1500 chars. */
  userPrompt: string
  /** The rated assistant reply's text content, truncated to 1500 chars. */
  assistantReply: string
  /** Tool names the rated reply invoked, in order (from its segments). */
  toolsUsed: string[]
}

export interface LoadChatFeedbackOptions {
  limit?: number
  rating?: 'up' | 'down'
  sinceMs?: number
}

/**
 * Load rated chat feedback entries, newest first.
 *
 * Executes a single SQL query joining `chat_feedback` → `chat_messages`
 * (assistant message) and a correlated subquery for the preceding user
 * message. Edge case: when the rated reply is the first message in the
 * thread, `userPrompt` is an empty string (not an error).
 */
export const loadChatFeedback = async (
  opts?: LoadChatFeedbackOptions,
): Promise<ChatFeedbackEntry[]> => {
  const c = stateClient()
  const limit = opts?.limit ?? 50

  const conditions: string[] = []
  const args: DbInValue[] = []

  if (opts?.rating !== undefined) {
    conditions.push('cf.rating = ?')
    args.push(opts.rating)
  }
  if (opts?.sinceMs !== undefined) {
    conditions.push('cf.created_at >= ?')
    args.push(opts.sinceMs)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  args.push(limit)

  const result = await c.execute({
    sql: `SELECT
            cf.message_id,
            cf.thread_id,
            cf.rating,
            cf.note,
            cf.created_at,
            am.content  AS assistant_content,
            am.segments AS assistant_segments,
            (SELECT um.content
               FROM chat_messages um
              WHERE um.thread_id = cf.thread_id
                AND um.role = 'user'
                AND um.seq < am.seq
              ORDER BY um.seq DESC
              LIMIT 1)  AS user_prompt
          FROM chat_feedback cf
          JOIN chat_messages am ON am.id = cf.message_id
          ${where}
          ORDER BY cf.created_at DESC
          LIMIT ?`,
    args,
  })

  return (result.rows as unknown as Record<string, unknown>[]).map((row) => ({
    messageId: row['message_id'] as string,
    threadId: row['thread_id'] as string,
    rating: row['rating'] as 'up' | 'down',
    note: (row['note'] as string | null) ?? null,
    createdAt: row['created_at'] as number,
    userPrompt: truncateText((row['user_prompt'] as string | null) ?? ''),
    assistantReply: truncateText((row['assistant_content'] as string | null) ?? ''),
    toolsUsed: extractToolsUsed(row['assistant_segments'] as string | null),
  }))
}
