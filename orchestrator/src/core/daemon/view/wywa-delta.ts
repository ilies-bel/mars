/**
 * "While you were away" delta assembler.
 *
 * Collects activity since the release-notes last-viewed cursor from five
 * existing stores and shapes each item into a plain-English one-liner:
 *
 *  1. Merges landed       – done arcs from the task store (release notes feed)
 *  2. Failed & recovered  – `recovery_spawned` trace events
 *  3. Auto-recipe runs    – rows from `auto_recipe_runs`
 *  4. Throttle events     – chat threads currently in `status='throttled'`
 *  5. Evaporated threads  – chat threads whose `evaporated_at` falls after `since`
 *
 * This module is a **pure assembler**: it receives pre-fetched data from the
 * route handler and performs no DB I/O itself. That makes it testable without a
 * live database and keeps the HTTP route as the only I/O boundary.
 */

export type WywaEventKind =
  | 'merge'
  | 'failure-recovered'
  | 'auto-recipe'
  | 'throttle'
  | 'evaporated-thread'

/** A single activity item returned by GET /view/wywa-delta. */
export interface WywaEvent {
  kind: WywaEventKind
  /** Plain-English, human-readable description. */
  summary: string
  /** ISO-8601 timestamp used for newest-first ordering. */
  at: string
}

export interface WywaDeltaInput {
  releaseNotes: ReadonlyArray<{ title: string; landedAt: string }>
  recoveryEvents: ReadonlyArray<{
    timestamp: string
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
  evaporatedThreads: ReadonlyArray<{ id: string; evaporatedAt: string }>
  /** ISO-8601 lower bound (exclusive). Null means no lower bound. */
  since: string | null
  /** Maximum events to return (already clamped by the caller). */
  limit: number
}

export const DEFAULT_WYWA_LIMIT = 30
export const MAX_WYWA_LIMIT = 100

/** Clamp a raw limit value into [1, MAX_WYWA_LIMIT]. */
export const clampWywaDeltaLimit = (raw: number | null): number => {
  if (raw === null || !Number.isFinite(raw) || raw < 1) return DEFAULT_WYWA_LIMIT
  return Math.min(raw, MAX_WYWA_LIMIT)
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
    if (!after(ev.timestamp, since)) continue
    const ref = ev.originId ?? ev.taskId
    const summary = ref
      ? `Task ${ref} failed and recovered`
      : 'A task failed and recovered'
    events.push({ kind: 'failure-recovered', summary, at: ev.timestamp })
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

  // 5. Evaporated (idle, then purged) chat threads
  for (const t of input.evaporatedThreads) {
    if (!after(t.evaporatedAt, since)) continue
    events.push({
      kind: 'evaporated-thread',
      summary: `Idle thread ${t.id} evaporated`,
      at: t.evaporatedAt,
    })
  }

  // Newest first
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  const capped = events.slice(0, limit)
  return { events: capped, andMore: events.length - capped.length }
}
