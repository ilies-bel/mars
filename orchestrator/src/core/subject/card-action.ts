/**
 * card-action — the single gate through which a Subject opens.
 *
 * Every Subject must be opened through this module. openSubject() is
 * intentionally restricted to one call site here; callers.test.ts enforces
 * this invariant with a grep-level architecture test.
 *
 * When the operator clicks a Card's primary action, the UI (or its server
 * endpoint) calls openSubjectFromCard with the Card's objective and
 * terminal_condition. Those values are forwarded verbatim to openSubject(),
 * which validates them, writes the row, and returns the new Subject.
 */

import { openSubject } from './openSubject.js'
import type { ChatThread } from '../lib/chat-store.js'

/** The subset of a Card record needed to open a Subject from its primary action. */
export interface CardOpenInput {
  /** Why this Subject exists — forwarded to Subject.objective. */
  objective: string
  /**
   * What "done" looks like — forwarded to Subject.terminal_condition.
   * Must be non-empty; openSubject throws SubjectInputError if blank.
   */
  terminal_condition: string
  /** Optional display title for the Subject sidebar row. */
  title?: string
}

/**
 * Open a Subject from a Card's primary action.
 *
 * Copies the Card's objective and terminal_condition into a new Subject.
 * This is the ONLY code path that may call openSubject(); routing through
 * any other call site is a constraint violation caught by callers.test.ts.
 */
export async function openSubjectFromCard(card: CardOpenInput): Promise<ChatThread> {
  return openSubject({
    objective: card.objective,
    terminal_condition: card.terminal_condition,
    title: card.title,
  })
}
