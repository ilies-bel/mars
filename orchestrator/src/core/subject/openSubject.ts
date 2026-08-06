/**
 * openSubject — the single validated entry point for creating a Subject.
 *
 * A Subject is a chat thread that exists for a declared purpose. Every Subject
 * must carry a non-empty `objective` (why it exists, one sentence) and a
 * non-empty `terminal_condition` (what "done" looks like). Both are required
 * at creation time; this function throws a typed error if either is absent or
 * blank so that no Subject can silently open without an account of itself.
 *
 * The sidebar renders the objective under the title (ChatPage.tsx
 * SubthreadRow); the terminal_condition is stored in the database for future
 * auto-close logic.
 */

import { randomUUID } from 'node:crypto'
import { withTransaction } from '../lib/db.js'
import { resolveStateClient } from '../store/state-client.js'
import type { ChatThread } from '../lib/chat-store.js'

/**
 * Thrown when openSubject is called with an empty or missing required field.
 *
 * Use `instanceof SubjectInputError` in error handlers to distinguish
 * validation failures from unexpected DB or network errors.
 */
export class SubjectInputError extends Error {
  readonly field: 'objective' | 'terminal_condition'

  constructor(field: 'objective' | 'terminal_condition', message: string) {
    super(message)
    this.name = 'SubjectInputError'
    this.field = field
  }
}

/** Input required to open a Subject. Both fields are mandatory and non-empty. */
export interface OpenSubjectInput {
  /** Why this Subject exists — one sentence the operator can read at a glance. */
  objective: string
  /**
   * What "done" looks like — the condition under which this Subject is
   * considered complete and eligible for archival. Stored verbatim; future
   * slices may evaluate it against domain events for auto-close.
   */
  terminal_condition: string
  /** Optional display title. Defaults to the empty string when omitted. */
  title?: string
}

/**
 * Create a new Subject with a validated objective and terminal condition.
 *
 * Throws `SubjectInputError` immediately — before any DB write — when either
 * required field is empty or blank.
 */
export async function openSubject(input: OpenSubjectInput): Promise<ChatThread> {
  if (!input.objective.trim()) {
    throw new SubjectInputError('objective', 'objective must not be empty')
  }
  if (!input.terminal_condition.trim()) {
    throw new SubjectInputError('terminal_condition', 'terminal_condition must not be empty')
  }

  const c = resolveStateClient()
  const id = randomUUID()
  const ts = Date.now()
  const title = input.title ?? ''

  await withTransaction(c, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO chat_threads
              (id, title, status, objective, terminal_condition, created_at, updated_at)
            VALUES (?, ?, 'idle', ?, ?, ?, ?)`,
      args: [id, title, input.objective, input.terminal_condition, ts, ts],
    })
  })

  return {
    id,
    title,
    status: 'idle',
    posture: 'triage',
    created_at: ts,
    updated_at: ts,
    origin: null,
    alert_item_id: null,
    alert_resolved: false,
    objective: input.objective,
    archived_at: null,
    closed_at: null,
    terminal_event_type: null,
    terminal_entity_id: null,
    parent_thread_id: null,
    fork_idempotency_key: null,
  }
}
