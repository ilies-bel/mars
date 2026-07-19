/**
 * startup-reconcile — portable reconcile pass shared by daemon boot and
 * the `mars sync` verb.
 *
 * Extracted from the inline `reconcile()` closure in server.ts so the
 * exact same recovery steps can run:
 *   (a) in the daemon process at boot (startDaemon calls this), and
 *   (b) on demand via `mars sync` — through the daemon RPC when alive,
 *       or standalone in the CLI process when the daemon is down.
 *
 * The individual recovery steps now live behind the `Reconciler` seam
 * (./reconciler.ts) and are registered in order in `RECONCILERS`
 * (./reconcilers.ts). This function is a thin orchestrator: it walks the
 * registry in order and merges each step's `ReconcileStepResult` into the
 * aggregate `ReconcileSummary`. Adding or reordering a step is now an edit to
 * the registry, not to this boot orchestrator.
 *
 * All closure captures from the original server.ts reconcile() are explicit
 * deps (`ReconcileDeps`) so the function has no hidden coupling to
 * startDaemon's scope.
 */

import {
  emptyReconcileSummary,
  type ReconcileDeps,
  type ReconcileSummary,
} from './reconciler'
import { RECONCILERS } from './reconcilers'

// Re-export the deps + summary types under their historical names so existing
// call sites and tests that import them from this module keep working.
export type StartupReconcileDeps = ReconcileDeps
export type { ReconcileSummary } from './reconciler'

/**
 * Run the full startup reconciliation pass by iterating the ordered
 * `RECONCILERS` registry.
 *
 * Step order (the registry encodes this exact sequence):
 *  1. Daemon-killed sweep — raise alert-only action queue items for tasks
 *     that were SIGKILL'd with a prior daemon; do NOT auto-requeue them.
 *  2. Daemon-died sweep — raise a `daemon-died` alert when the previous
 *     daemon exited uncleanly (crash, OOM, SIGKILL, bypass of shutdown()).
 *  3. Blocker-drift repair — demote any `queued` task that still has
 *     incomplete blockers back to `blocked` (catches invariant violations
 *     in any promotion path).
 *  3. Orphaned-blocked scan — re-queue any `blocked` task whose blocker
 *     edges have all resolved or been removed.  This is the fix for the
 *     wedge case where `dropTask` deleted edges but left dependents blocked.
 *  4. Recovery-done propagation — replay any completed recovery (kind='fix',
 *     status='done') whose origin was never flipped to 'done'. Covers the
 *     missed-event case where a daemon crash between FF-merge and outbox
 *     delivery left the origin in 'failed' and its dependents stranded in
 *     'blocked'. Idempotent; swallows its own errors.
 *  5. Reseed dispatch — emit task.added / task.queued for all draft/queued
 *     rows so the dispatch loop picks them up.
 *  6. Requeue stale-running — tasks that were `running` when the prior
 *     daemon died are re-queued from setup (no retry budget burn).
 *  7. Orphan span sweep — mark any unclosed step spans from prior daemons
 *     as killed so the Agents page never shows permanently-live sessions.
 *  8. Verifying recovery — if worktree survives, clear and re-queue; else
 *     mark failed.
 *  9. Merging recovery — if the FF already landed, finalize to done; else
 *     clear worktree and re-queue.
 * 10. Stalled-proposal slice — pick up prd-ready proposals that were
 *     promoted while the daemon was offline.
 *
 * Error semantics are preserved verbatim from the original hand-called
 * sequence: steps 1, 2, 3, 4, 7 and 10 swallow their own errors (log + continue);
 * steps 5, 6, 8 and 9 do not, so a throw inside them rejects the whole pass.
 * This orchestrator therefore does NOT add a blanket per-step try/catch —
 * each step owns its error policy.
 */
export const runStartupReconcile = async (
  deps: StartupReconcileDeps,
): Promise<ReconcileSummary> => {
  const summary = emptyReconcileSummary()

  for (const reconciler of RECONCILERS) {
    const result = await reconciler.run(deps)
    Object.assign(summary, result)
  }

  return summary
}
