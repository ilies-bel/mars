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
import type { MergeJobStore } from '../store/merge-job-store'
import type { DomainTaskStore } from '../store/task-store'

// Re-export the deps + summary types under their historical names so existing
// call sites and tests that import them from this module keep working.
export type StartupReconcileDeps = ReconcileDeps
export type { ReconcileSummary } from './reconciler'

/**
 * Re-hydrate the merge queue from durable task state on daemon startup.
 *
 * Two operations:
 *
 * 1. **Reset** — any `merge_jobs` row in `claimed` or `running` from a prior
 *    daemon is reset to `queued` with `attempts` incremented and `claimed_at` /
 *    `started_at` cleared.  A prior daemon left these rows in-flight when it
 *    exited; the merge has not finished and must be retried.
 *
 * 2. **Rebuild** — any task in `status='merging'` that has no active
 *    (queued/claimed/running) `merge_jobs` row gets a fresh `queued` row
 *    inserted.  This covers the gap where the daemon died after setting the
 *    task status to `merging` but before the merge_jobs row was persisted.
 *
 * Called by the `merge-jobs-startup-reconcile` registry step (reconcilers.ts)
 * and exported separately so tests can call it in isolation with injected deps.
 */
export const reconcileMergeJobs = async (deps: {
  store: MergeJobStore
  taskStore: DomainTaskStore
  log: (line: string) => void
}): Promise<{ resetCount: number; rebuiltCount: number }> => {
  const { store, taskStore, log } = deps

  // ── 1. Reset stuck claimed/running rows back to queued ──────────────────────
  //
  // Read the current stuck rows first (to capture their previous status for
  // the warning log), then do a single bulk UPDATE.  This is safe at startup
  // because no other consumer is running yet.
  const stuckClaimed = await store.listByStatus('claimed')
  const stuckRunning = await store.listByStatus('running')
  const stuckJobs = [...stuckClaimed, ...stuckRunning]

  let resetCount = 0
  if (stuckJobs.length > 0) {
    await taskStore.execute(
      `UPDATE merge_jobs
       SET    status     = 'queued',
              attempts   = attempts + 1,
              claimed_at = NULL,
              started_at = NULL,
              updated_at = NOW()
       WHERE  status IN ('claimed', 'running')`,
    )
    for (const job of stuckJobs) {
      log(
        `[reconcile] merge-jobs-startup: reset ${job.status} job ${job.id} for task ${job.taskId} back to queued (prior daemon left it in-flight)`,
      )
      resetCount++
    }
  }

  // ── 2. Rebuild merge jobs for orphan merging tasks ──────────────────────────
  //
  // A task can be in `merging` status with no active merge_jobs row when the
  // daemon died between setting task.status='merging' and inserting the job row.
  const orphanResult = await taskStore.query(`
    SELECT t.id, t.worktree_path, t.branch
    FROM   tasks t
    WHERE  t.status = 'merging'
    AND    NOT EXISTS (
             SELECT 1 FROM merge_jobs mj
             WHERE  mj.task_id = t.id
             AND    mj.status IN ('queued', 'claimed', 'running')
           )
  `)

  const integrationBranch = process.env.INTEGRATION_BRANCH ?? 'main'
  let rebuiltCount = 0
  for (const row of orphanResult.rows) {
    const taskId = row.id as string
    const worktreePath = (row.worktree_path as string | null) ?? ''
    const branch = (row.branch as string | null) ?? `task/${taskId}`
    await store.enqueue({ taskId, integrationBranch, worktreePath, branch })
    log(
      `[reconcile] merge-jobs-startup: rebuilt queued merge job for orphan merging task ${taskId}`,
    )
    rebuiltCount++
  }

  return { resetCount, rebuiltCount }
}

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
 * 9b. Vega-reconciling recovery — tasks stranded while the vcs-supervisor
 *     was running. Vega's subprocess died with the daemon; the worktree may
 *     be in a partial rebase state. Always discard it and requeue from setup
 *     (or finalize to done if the branch already landed).
 * 10. Stranded-slicing proposal recovery — return a slice claim left by a
 *     prior daemon to prd-ready before any stalled proposal is dispatched.
 * 11. Stalled-proposal slice — pick up prd-ready proposals that were
 *     promoted while the daemon was offline.
 * 11. Workflow-install drift — raise one operator alert for every bundled
 *     Workflow missing from `.mars/workflows`, or resolve it once restored.
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
