/**
 * Process-local dispatch hint for tasks created *inside* the daemon process.
 *
 * ## Why this exists
 *
 * The daemon's `drain()` loop picks work exclusively from the TaskFlightTracker's
 * in-memory `pending*` sets. Rows are pushed into those sets from exactly three
 * places:
 *
 *  1. the `task.added` / `task.queued` bus handlers in `startDaemon` — fired by
 *     the `add` RPC handler, i.e. `mars task add`;
 *  2. the `reseed-dispatch` reconciler, which runs **once, at daemon startup**;
 *  3. the poll-fallback tick, which returns early unless the daemon is
 *     completely idle (`tracker.inFlightCount() > 0`).
 *
 * A task the orchestrator creates for itself mid-flight — a rescue-operator for
 * a dead-ended arc, say — hits none of those. It is written straight to the
 * database and returns, so it is invisible to `drain()` until the daemon either
 * falls fully idle or is restarted. On a busy daemon that is indefinitely, and
 * the rows accumulate.
 *
 * This module is the missing seam: the writer signals "this id is ready", the
 * daemon translates that into the pending-set push + `drain()` that
 * `orchestrator/AGENTS.md` ("Daemon worker pool") mandates. Deliberately
 * modelled on `src/outbox/wake-hint.ts`, which solves the same
 * publisher-cannot-reach-the-consumer problem for the outbox dispatcher.
 *
 * ## Contract
 *
 * - The hint is a **scheduling nudge, not a state transition.** The row must
 *   already be persisted in a status that the target kind accepts (`'queued'`
 *   for `'implement'`, `'draft'` for `'triage'`) before hinting. The daemon
 *   re-reads and re-validates the row before dispatching it, so a stale or
 *   duplicate hint is harmless.
 * - Safe no-op when nothing is registered: the CLI, the workflow test harness,
 *   and unit tests all run without a daemon. Delivery still happens eventually
 *   via the startup reconciler and the poll-fallback; the hint only removes the
 *   wait.
 * - Not durable. A hint dropped by a crash is recovered by the startup
 *   reconciler, which is the durable backstop.
 */

import type { ClaimableKind } from './task-flight-tracker'

/**
 * Callback invoked with a freshly created task id and the dispatch kind it
 * should be scheduled under. Registered by `startDaemon`.
 */
export type DispatchHint = (taskId: string, kind: ClaimableKind) => void

/** Module-level registry of active hints. Mirrors `wake-hint.ts`. */
const hints = new Set<DispatchHint>()

/**
 * Register a dispatch hint. Returns a deregister function that removes this
 * specific hint — call it on daemon shutdown so a restarted daemon in the same
 * process does not fan out to a dead tracker.
 */
export const registerDispatchHint = (hint: DispatchHint): (() => void) => {
  hints.add(hint)
  return () => {
    hints.delete(hint)
  }
}

/**
 * Signal that `taskId` was just persisted and is ready to be scheduled under
 * `kind`. Synchronously calls every registered hint. A throwing hint must never
 * take down the writer that created the task, so each call is isolated — the
 * task row is already committed and the startup reconciler will pick it up even
 * if every hint fails.
 */
export const hintDispatch = (taskId: string, kind: ClaimableKind): void => {
  for (const hint of hints) {
    try {
      hint(taskId, kind)
    } catch {
      // Best-effort: the reconciler is the durable backstop.
    }
  }
}
