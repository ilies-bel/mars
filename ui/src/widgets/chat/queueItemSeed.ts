/**
 * The opening message Mars posts when an operator clicks an alert.
 *
 * A thread that opens blank makes the operator restate the problem before they
 * can ask about it — and they clicked the row precisely because they had not
 * worked it out yet. So the thread starts with what Mars already knows: what is
 * wrong, what it concerns, and what the available moves are.
 *
 * Everything here comes from the row itself. Nothing is inferred or invented:
 * if a field is missing the corresponding line is omitted rather than guessed,
 * because a confidently wrong opener is worse than a short one.
 */

import { deriveCause } from '@/shared/alertCause'
import type { ActionQueueItem } from '@/shared/schemas'

/**
 * Fallback opening sentence per kind, used ONLY when the row carries no
 * `humanSummary`.
 *
 * The recipe-driven summary already states the problem in the operator's
 * language, so prefixing it with a lead produced sentences that said the same
 * thing twice ("A verify gate is broken. A verify gate keeps failing the same
 * way…"). These exist for rows from daemon versions that predate the recipe
 * fields, where the alternative is a bare kind slug.
 */
const KIND_LEAD: Record<string, string> = {
  'daemon-code-drift': 'The running daemon is older than the code on disk',
  'daemon-died': 'The background engine crashed and restarted',
  'stale-queued': 'A task has been sitting in the queue without being picked up',
  'stale-worktree': 'A worktree is left over from a task that is no longer running',
  'gate-broken': 'A verify gate is broken',
  'baseline-broken': 'The shared baseline is broken',
  'signature-storm': 'The same failure is repeating across tasks',
  'subscriber-stalled': 'An event subscriber has stalled',
  'phantom-task': 'A task row no longer matches the state on disk',
  'worktree-ahead': 'A branch has commits that were never merged',
  'orphaned-origin': 'A recovery task has lost the task it was fixing',
  'steward-repeat': 'The steward has flagged the same thing repeatedly',
  'reflect-recommended': 'Mars has spotted patterns worth reflecting on',
  'awaiting-human': 'A live task is parked waiting for you',
  'awaiting-validation': 'A task is waiting for you to check its preview',
  'gate-enrichment': 'A candidate verify gate needs your decision',
  'scorer-suggested': 'A scorer change has been suggested',
  'e2e-tooling-missing': 'End-to-end tooling is missing',
}

export const buildQueueItemSeed = (item: ActionQueueItem): string => {
  const lines: string[] = []

  const headline = item.humanSummary?.trim() || item.title?.trim() || ''
  lines.push(headline || KIND_LEAD[item.kind] || `Something needs you (${item.kind}).`)

  const cause = deriveCause(item.humanDetail)
  if (cause) lines.push('', `Cause: ${cause}`)

  if (item.entityId) lines.push('', `This concerns ${item.entityId}.`)

  // The body often carries the raw signal (a verify tail, a stack). Keep it,
  // but bounded — the point is to orient, not to paste a log into the opener.
  const body = item.body?.trim()
  if (body && body !== headline) {
    const clipped = body.length > 600 ? `${body.slice(0, 600)}…` : body
    lines.push('', clipped)
  }

  const verbs = (item.verbs ?? []).map((verb) => verb.label).filter(Boolean)
  if (verbs.length > 0) {
    lines.push('', `Your options: ${verbs.join(', ')}.`)
  }

  lines.push('', 'Ask me anything about it, or use the buttons above.')

  return lines.join('\n')
}
