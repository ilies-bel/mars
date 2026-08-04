/**
 * "Nothing on my side — want to grill X?"
 *
 * The one case where Mars speaks without anything having happened. It is
 * therefore the one most likely to become noise, so it is fenced hard: it
 * fires only when the queue is genuinely empty, only when there is a specific
 * draft waiting, and never twice for the same draft.
 */

import type { DbClient } from '../db.js'

export interface IdleProposalOffer {
  proposalId: string
  title: string
}

/**
 * Statuses that mean Mars still has work in hand. `blocked` counts: a blocked
 * task is waiting on something, and offering new work while the operator is
 * untangling a dependency is exactly the interruption this must not be.
 */
const ACTIVE_TASK_STATUSES = ['queued', 'running', 'blocked'] as const

export interface DetectIdleProposalOptions {
  /** Skip the "already offered" check — used by tests, never in production. */
  ignoreHistory?: boolean
}

/**
 * Decide whether to offer a draft, and which one.
 *
 * Returns `null` for every reason not to speak, deliberately without
 * distinguishing them: there is no partial version of this Notice, and a
 * caller that could tell "busy" from "nothing to offer" would be tempted to
 * say something in the second case.
 */
export const detectIdleProposal = async (
  c: DbClient,
  options: DetectIdleProposalOptions = {},
): Promise<IdleProposalOffer | null> => {
  const active = await c.execute({
    sql: `SELECT 1 FROM tasks WHERE status = ANY(?) LIMIT 1`,
    args: [[...ACTIVE_TASK_STATUSES]],
  })
  if (active.rows.length > 0) return null

  const drafts = await c.execute(
    `SELECT id, title FROM proposals
      WHERE status = 'draft' AND title <> ''
      ORDER BY created_at ASC, id ASC`,
  )

  for (const row of drafts.rows as unknown as { id: string; title: string }[]) {
    if (options.ignoreHistory === true) return { proposalId: row.id, title: row.title }
    // The feed is the record of what Mars has already said. Asking it directly
    // beats a parallel "already offered" table that could drift out of step
    // with what the operator can actually see.
    const offered = await c.execute({
      sql: `SELECT 1 FROM chat_messages
             WHERE kind = 'notice' AND segments::text LIKE ?
             LIMIT 1`,
      args: [`%open-proposal-subject%${row.id}%`],
    })
    if (offered.rows.length === 0) return { proposalId: row.id, title: row.title }
  }
  return null
}
