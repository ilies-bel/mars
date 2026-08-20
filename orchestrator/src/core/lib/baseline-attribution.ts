/**
 * Single source of truth for "which currently-failed tasks are attributable
 * to a poisoned integration branch, not to their own code."
 *
 * Motivating incident (2026-08-18): the integration branch's lockfile carried
 * an unsatisfiable dependency pin. Nine tasks were enqueued, three dispatched
 * before the baseline health checker (baseline-health.ts) caught it, and all
 * three died in `setup` with an identical `setup:install/install-frozen-lockfile`
 * signature moments later. The action queue reported that as three
 * independent task defects — an operator reading it saw a wall of
 * unrelated-looking failures with no statement of the actual, shared cause.
 *
 * Two consumers need the same answer to "was this failure the baseline's
 * fault":
 *   1. The `baseline-broken` / `failed` derived action-queue rows
 *      (derived-conditions.ts) — so N task failures collapse into one
 *      baseline-attributed report instead of N independent alerts.
 *   2. The reflect corpus (reflect-query.ts, invoked from server.ts,
 *      app-services.ts's `viewReflect`, and the `mars reflect` CLI) — so a
 *      reflection pass never attributes N task defects to what was really
 *      one shared, transient baseline incident.
 *
 * Correlation is on TIME, not on pattern-matching the failure text: a task
 * counts as baseline-caught when it reached `failed` at or after the
 * baseline pause began (`pauseState.since`), while the checker's live probe
 * (slice 1) says the baseline is poisoned and the pause controller (slice 2)
 * says dispatch is down specifically because of it. This works for whatever
 * failing step is involved (`setup:install` today; anything else the same
 * broken baseline breaks tomorrow) without a per-signature allowlist, and it
 * generalizes past the one incident that motivated it.
 *
 * The first-cause-wins pause semantics (pause-state.ts) mean `pauseState`
 * can be non-null with `reason !== 'baseline'` even while the baseline is
 * genuinely poisoned — e.g. an operator pause landed first. In that case
 * there is no reliable "since" to correlate against, so this conservatively
 * attributes nothing rather than guessing and over-suppressing an unrelated
 * task's alert.
 */

import type { DbTx } from './db'
import type { DispatchPauseState } from '../daemon/pause-state'

/**
 * Returns the ids of tasks with `status = 'failed'` whose failure is
 * attributable to the poisoned baseline, per the correlation described above.
 * Returns an empty set whenever the baseline is not currently poisoned, or
 * the current pause is not held for `reason: 'baseline'`.
 *
 * Takes the narrow `DbTx` (single `execute`) rather than the full `DbClient`
 * so callers that only have a `DomainTaskStore`/`Scope` handle (the reflect
 * corpus loader runs over a `TaskStore`, not a raw `DbClient`) can pass it
 * directly — both already expose a structurally-compatible `execute`.
 */
export async function findBaselineCaughtTaskIds(
  client: DbTx,
  isBaselinePoisoned: boolean,
  pauseState: DispatchPauseState | null,
): Promise<ReadonlySet<string>> {
  if (!isBaselinePoisoned) return new Set()
  if (!pauseState || pauseState.reason !== 'baseline' || !pauseState.since) return new Set()

  const result = await client.execute(
    `SELECT id FROM tasks WHERE status = 'failed' AND updated_at >= ?`,
    [pauseState.since],
  )
  return new Set(result.rows.map((r) => (r as { id: string }).id))
}
