/**
 * ask — the read-only Q&A path for the main thread.
 *
 * The main thread is an account the operator reads, not a task-submission
 * channel. Any free-text question submitted via the main-thread composer
 * routes here. This module MUST NOT import from queue.ts (enqueueTask) or
 * subject/openSubject.ts (openSubject) — those paths create domain entities,
 * which the main thread never does.
 *
 * Each call writes exactly one `main_thread_entries` row of kind='answer'
 * and returns the entry. No tasks, no subjects, no side effects beyond that
 * single DB write.
 */

import type { DbClient } from '../lib/db.js'

export interface AnswerEntry {
  id: number
  kind: 'answer'
  payload: { question: string; answer: string }
  createdAt: string
}

/**
 * Static answer returned for every question submitted through the main-thread
 * composer. The main thread is a read-only view; Cards are the entry point
 * for any work. This string is intentionally zero-cost (no LLM call).
 */
const READ_ONLY_ANSWER =
  'The main thread is a read-only account of what Mars is doing. ' +
  'Cards are the only entry point for opening a Subject or starting new work. ' +
  'Submit a question here to learn more about current activity — ' +
  'but to kick off a task or open a Subject, use a Card.'

/**
 * Submit a question to the main-thread Q&A path.
 *
 * Writes one `main_thread_entries` row of `kind='answer'` and returns it.
 * Never enqueues a task, opens a Subject, or mutates any other domain entity.
 *
 * @param db       DB client — injected so callers can supply a test double.
 * @param question The operator's free-text question.
 */
export async function ask(db: DbClient, question: string): Promise<AnswerEntry> {
  const answer = READ_ONLY_ANSWER
  const payload = JSON.stringify({ question, answer })

  const { rows } = await db.execute({
    sql: `INSERT INTO main_thread_entries (kind, payload)
          VALUES ('answer', ?)
          RETURNING id, kind, payload, created_at`,
    args: [payload],
  })

  const row = rows[0]!
  // payload is returned as a parsed object by the DB adapter (JSONB)
  const parsedPayload =
    typeof row.payload === 'string'
      ? (JSON.parse(row.payload) as { question: string; answer: string })
      : (row.payload as { question: string; answer: string })

  return {
    id: Number(row.id),
    kind: 'answer',
    payload: parsedPayload,
    createdAt: String(row.created_at),
  }
}
