/**
 * "While you were away" delta assembler.
 *
 * Collects activity since the release-notes last-viewed cursor from six
 * existing stores and shapes each item into a plain-English one-liner:
 *
 *  1. Merges landed       – done arcs from the task store (release notes feed)
 *  2. Failed & recovered  – `recovery_spawned` trace events
 *  3. Auto-recipe runs    – rows from `auto_recipe_runs`
 *  4. Throttle events     – chat threads currently in `status='throttled'`
 *  5. Closed Subthreads     – chat threads whose `closed_at` falls after `since`
 *  6. Steward interventions – immutable entries from the Steward ledger
 *
 * This module is a **pure assembler**: it receives pre-fetched data from the
 * route handler and performs no DB I/O itself. That makes it testable without a
 * live database and keeps the HTTP route as the only I/O boundary.
 */

import type { StewardLedgerRow } from '../../steward-ledger'

export type WywaEventKind =
  | 'merge'
  | 'failure-recovered'
  | 'auto-recipe'
  | 'throttle'
  | 'closed-subthread'
  | 'steward'

/** A single activity item returned by GET /view/wywa-delta. */
export interface WywaEvent {
  /** Stable source identifier when the event can appear in overlapping reads. */
  id?: string
  kind: WywaEventKind
  /** Event category supplied by sources that publish a domain-specific type. */
  type?: 'steward'
  /** Plain-English, human-readable description. */
  summary: string
  /** ISO-8601 timestamp used for newest-first ordering. */
  at: string
}

export interface WywaDeltaInput {
  releaseNotes: ReadonlyArray<{ title: string; landedAt: string }>
  recoveryEvents: ReadonlyArray<{
    timestamp: number
    taskId: string | null
    originId: string | null
  }>
  autoRuns: ReadonlyArray<{
    actionOp: string
    taskId: string | null
    signature: string
    ranAt: string
  }>
  throttledThreads: ReadonlyArray<{ id: string; updatedAt: string }>
  closedSubthreads: ReadonlyArray<{ id: string; closedAt: string }>
  stewardLedger: ReadonlyArray<StewardLedgerRow>
  /** ISO-8601 lower bound (exclusive). Null means no lower bound. */
  since: string | null
  /** Maximum events to return (already clamped by the caller). */
  limit: number
}

export const DEFAULT_WYWA_LIMIT = 30
export const MAX_WYWA_LIMIT = 100

/**
 * Clamp a raw limit value into [1, MAX_WYWA_LIMIT].
 * Null or non-finite → DEFAULT_WYWA_LIMIT; valid number → Math.min(Math.max(1, raw), MAX_WYWA_LIMIT).
 */
export const clampWywaDeltaLimit = (raw: number | null): number => {
  if (raw === null || !Number.isFinite(raw)) return DEFAULT_WYWA_LIMIT
  return Math.min(Math.max(1, raw), MAX_WYWA_LIMIT)
}

const after = (at: string, since: string | null): boolean =>
  since === null || at > since

/**
 * Assemble the delta from pre-fetched source data.
 *
 * Returns the first {@link WywaDeltaInput.limit} events (newest first) plus
 * `andMore`: the count of events that were truncated beyond the cap.
 */
export const assembleDelta = (
  input: WywaDeltaInput,
): { events: WywaEvent[]; andMore: number } => {
  const { since, limit } = input
  const events: WywaEvent[] = []

  // 1. Merges landed
  for (const rn of input.releaseNotes) {
    if (!after(rn.landedAt, since)) continue
    events.push({ kind: 'merge', summary: `Merged: ${rn.title}`, at: rn.landedAt })
  }

  // 2. Failed and recovered (recovery_spawned trace events)
  for (const ev of input.recoveryEvents) {
    const timestamp = new Date(ev.timestamp).toISOString()
    if (!after(timestamp, since)) continue
    const ref = ev.originId ?? ev.taskId
    const summary = ref
      ? `Task ${ref} failed and recovered`
      : 'A task failed and recovered'
    events.push({ kind: 'failure-recovered', summary, at: timestamp })
  }

  // 3. Auto-recipe runs
  for (const run of input.autoRuns) {
    if (!after(run.ranAt, since)) continue
    const task = run.taskId ? ` on ${run.taskId}` : ''
    events.push({
      kind: 'auto-recipe',
      summary: `Auto-${run.actionOp}${task} (${run.signature})`,
      at: run.ranAt,
    })
  }

  // 4. Rate-limited (throttled) chat threads
  for (const t of input.throttledThreads) {
    if (!after(t.updatedAt, since)) continue
    events.push({
      kind: 'throttle',
      summary: `Rate limit hit on chat thread ${t.id}`,
      at: t.updatedAt,
    })
  }

  // 5. Closed Subthreads remain part of the durable conversation.
  for (const t of input.closedSubthreads) {
    if (!after(t.closedAt, since)) continue
    events.push({
      kind: 'closed-subthread',
      summary: `Subthread ${t.id} closed`,
      at: t.closedAt,
    })
  }

  // 6. Steward interventions. The ledger is append-only, but overlapping
  // cursor reads can include the same immutable row more than once.
  const stewardLedgerIds = new Set<string>()
  for (const intervention of input.stewardLedger) {
    if (!after(intervention.ts, since) || stewardLedgerIds.has(intervention.id)) continue
    stewardLedgerIds.add(intervention.id)
    const shortCommit = intervention.commitSha?.slice(0, 7)
    events.push({
      id: `steward:${intervention.id}`,
      kind: 'steward',
      type: 'steward',
      summary: `Steward ${intervention.targetKind} ${intervention.targetId}: ${intervention.recipeId} — ${intervention.outcome}${shortCommit ? ` (${shortCommit})` : ''}`,
      at: intervention.ts,
    })
  }

  // Newest first
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  const capped = events.slice(0, limit)
  return { events: capped, andMore: events.length - capped.length }
}
