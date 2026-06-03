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
 * All closure captures from the original server.ts reconcile() are now
 * explicit deps so the function has no hidden coupling to startDaemon's
 * scope.
 */

import { EventEmitter } from 'node:events'
import {
  hasIncompleteBlockers,
  listTasks,
  updateTask,
} from '../queue'
import { listProposals } from '../proposals'
import { sweepOrphanRunningSpans, type TraceEventStore } from '../lib/trace-events-store'
import { recoverAllBlockedTasks } from '../blocker-resolution'

export interface StartupReconcileDeps {
  log: (line: string) => void
  bus: EventEmitter
  /**
   * TraceEventStore for orphan span sweeping.  Pass `null` when the store
   * is not available (standalone / no-daemon path) — the span sweep is
   * skipped gracefully.
   */
  traceStore: TraceEventStore | null
  /**
   * Proposal-slicing callback.  Pass `null` when there is no dispatch loop
   * (standalone path) — stalled prd-ready proposals are detected and logged
   * but not sliced.
   */
  handleProposalSlice: ((proposalId: string) => Promise<unknown>) | null
}

export interface ReconcileSummary {
  daemonKilledAlerts: number
  blockerDriftRepaired: number
  /** Tasks flipped from blocked→queued because they had zero live blocker edges. */
  orphanedBlockedRequeued: number
  runningRequeued: number
  orphanSpansSwept: number
  verifyingRequeued: number
  verifyingFailed: number
  mergingFinalized: number
  mergingRequeued: number
  stalledProposalsSliced: number
}

/**
 * Run the full startup reconciliation pass.
 *
 * Steps (in order):
 *  1. Daemon-killed sweep — raise alert-only action queue items for tasks
 *     that were SIGKILL'd with a prior daemon; do NOT auto-requeue them.
 *  2. Blocker-drift repair — demote any `queued` task that still has
 *     incomplete blockers back to `blocked` (catches invariant violations
 *     in any promotion path).
 *  3. Orphaned-blocked scan — re-queue any `blocked` task whose blocker
 *     edges have all resolved or been removed.  This is the fix for the
 *     wedge case where `dropTask` deleted edges but left dependents blocked.
 *  4. Reseed dispatch — emit task.added / task.queued for all draft/queued
 *     rows so the dispatch loop picks them up.
 *  5. Requeue stale-running — tasks that were `running` when the prior
 *     daemon died are re-queued from setup (no retry budget burn).
 *  6. Orphan span sweep — mark any unclosed step spans from prior daemons
 *     as killed so the Agents page never shows permanently-live sessions.
 *  7. Verifying recovery — if worktree survives, clear and re-queue; else
 *     mark failed.
 *  8. Merging recovery — if the FF already landed, finalize to done; else
 *     clear worktree and re-queue.
 *  9. Stalled-proposal slice — pick up prd-ready proposals that were
 *     promoted while the daemon was offline.
 */
export const runStartupReconcile = async (
  deps: StartupReconcileDeps,
): Promise<ReconcileSummary> => {
  const { log, bus, traceStore, handleProposalSlice } = deps

  const summary: ReconcileSummary = {
    daemonKilledAlerts: 0,
    blockerDriftRepaired: 0,
    orphanedBlockedRequeued: 0,
    runningRequeued: 0,
    orphanSpansSwept: 0,
    verifyingRequeued: 0,
    verifyingFailed: 0,
    mergingFinalized: 0,
    mergingRequeued: 0,
    stalledProposalsSliced: 0,
  }

  // ── 1. Daemon-killed sweep ──────────────────────────────────────────────────
  // Tasks SIGKILL'd with a prior daemon are stamped `failureSignature:
  // 'daemon-killed'` and left in `failed`. We do NOT auto-requeue them —
  // raise one alert-only actionQueue item per task so the operator decides.
  try {
    const { detectAndRaiseDaemonKilled } = await import('./daemon-killed-sweep')
    const raised = await detectAndRaiseDaemonKilled()
    summary.daemonKilledAlerts = raised.length
    if (raised.length > 0) {
      log(
        `[reconcile] raised ${raised.length} daemon-killed alert(s) (alert-only; not auto-requeued)`,
      )
    }
  } catch (err) {
    log(`[reconcile] daemon-killed sweep failed: ${(err as Error).message}`)
  }

  // ── 2. Blocker-drift repair ─────────────────────────────────────────────────
  // Any task in status='queued' with incomplete blockers violates the invariant
  // and must be demoted back to 'blocked' BEFORE we re-seed the dispatch queue.
  try {
    const { repairQueuedWithIncompleteBlockers } = await import('./reconcile-blocker-drift')
    const demoted = await repairQueuedWithIncompleteBlockers()
    summary.blockerDriftRepaired = demoted.length
    for (const taskId of demoted) {
      log(
        `[reconcile] BUG: task ${taskId} was queued with incomplete blockers — demoted to blocked`,
      )
    }
  } catch (err) {
    log(`[reconcile] blocker-drift repair failed: ${(err as Error).message}`)
  }

  // ── 3. Orphaned-blocked scan ────────────────────────────────────────────────
  // Re-queue any `blocked` task whose blocker edges have all resolved or been
  // removed (the zero-edge orphan case).  recoverAllBlockedTasks() uses the
  // same safe guard as the unblock machinery: a task with ANY live (non-done)
  // blocker edge returns 'noop', so this never promotes a legitimately-blocked
  // task.  Must run AFTER drift repair so we don't promote a task that was
  // demoted in step 2.
  try {
    const { outcomes } = await recoverAllBlockedTasks()
    const requeued = outcomes.filter((o) => o.outcome === 'queued')
    summary.orphanedBlockedRequeued = requeued.length
    for (const o of requeued) {
      log(`[reconcile] task ${o.taskId} orphaned-blocked; re-queued`)
      bus.emit('task.queued', { taskId: o.taskId })
    }
  } catch (err) {
    log(`[reconcile] orphaned-blocked scan failed: ${(err as Error).message}`)
  }

  // ── 4. Reseed dispatch ──────────────────────────────────────────────────────
  const drafts = await listTasks('draft')
  for (const t of drafts) bus.emit('task.added', { taskId: t.id })

  const queued = await listTasks('queued')
  for (const t of queued) bus.emit('task.queued', { taskId: t.id })

  // ── 5. Requeue stale-running ────────────────────────────────────────────────
  // Tasks that were `running` when the prior daemon died: re-queue from setup
  // (daemon restart is not a task fault; do NOT consume the retry budget).
  {
    const { requeueRunningTasksFromPriorDaemon } = await import('./reconcile-running')
    const { getRepoRoot } = await import('../context')
    const requeued = await requeueRunningTasksFromPriorDaemon(getRepoRoot())
    summary.runningRequeued = requeued.length
    for (const taskId of requeued) {
      log(`[reconcile] task ${taskId} was running on prior daemon; requeued from setup`)
      bus.emit('task.queued', { taskId })
    }
  }

  // ── 6. Orphan span sweep ────────────────────────────────────────────────────
  // Any step_started with no step_ended belongs to a prior daemon that crashed
  // without closing its spans. Skipped when traceStore is unavailable
  // (standalone / no-daemon path).
  if (traceStore !== null) {
    try {
      const swept = await sweepOrphanRunningSpans(traceStore)
      summary.orphanSpansSwept = swept
      if (swept > 0) {
        log(`[reconcile] swept ${swept} orphan running span(s) to killed`)
      }
    } catch (err) {
      log(`[reconcile] orphan span sweep failed: ${(err as Error).message}`)
    }
  }

  // ── 7. Verifying recovery ───────────────────────────────────────────────────
  const { existsSync: exists } = await import('node:fs')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const { removeWorktree, isBranchMergedIntoMain } = await import('../lib/git')
  const { getRepoRoot } = await import('../context')

  const verifying = await listTasks('verifying')
  for (const t of verifying) {
    if (t.branch && t.worktreePath && exists(t.worktreePath)) {
      // The prior daemon ran this task but the engine run has no checkpoint
      // rows to resume from — clear the in-flight worktree + branch and
      // re-queue from a clean setup, mirroring the merging not-landed path.
      const branch = t.branch
      if (exists(t.worktreePath)) {
        await removeWorktree({ path: t.worktreePath, branch }, true).catch(() => {})
      }
      await exec('git', ['branch', '-D', branch], { cwd: getRepoRoot() }).catch(() => {})
      const verifyingHasBlockers = await hasIncompleteBlockers(t.id).catch(() => false)
      if (verifyingHasBlockers) {
        log(
          `[reconcile] task ${t.id} was verifying; has incomplete blockers, restored to blocked`,
        )
        await updateTask(t.id, {
          status: 'blocked',
          branch: null,
          worktreePath: null,
          claudeSessionId: null,
          error: null,
          failedPhase: null,
        }).catch(() => {})
      } else {
        log(
          `[reconcile] task ${t.id} was verifying; clearing worktree and re-queuing from setup`,
        )
        await updateTask(t.id, {
          status: 'queued',
          branch: null,
          worktreePath: null,
          claudeSessionId: null,
          error: null,
          failedPhase: null,
        }).catch(() => {})
        bus.emit('task.queued', { taskId: t.id })
        summary.verifyingRequeued++
      }
    } else {
      log(
        `[reconcile] task ${t.id} was verifying; worktree missing, marking failed`,
      )
      if (t.worktreePath) {
        const branch = t.branch ?? `task/${t.id}`
        try {
          await removeWorktree({ path: t.worktreePath, branch }, true, true)
          log(`[reconcile] removed stale worktree registration for ${t.id} at ${t.worktreePath}`)
        } catch {
          log(`[reconcile] worktree cleanup skipped for ${t.id}: not registered or already removed`)
        }
      }
      await updateTask(t.id, {
        status: 'failed',
        error: 'daemon restart while task was verifying; worktree missing',
        failedPhase: 'verify',
        failureReason: 'daemon restart while task was verifying; worktree missing',
        failureReasonCode: 'unknown',
      }).catch(() => {})
      summary.verifyingFailed++
    }
  }

  // ── 8. Merging recovery ─────────────────────────────────────────────────────
  const merging = await listTasks('merging')
  for (const t of merging) {
    const branch = t.branch ?? `task/${t.id}`
    const landed = await isBranchMergedIntoMain(branch, getRepoRoot()).catch(() => false)
    if (landed) {
      log(
        `[reconcile] task ${t.id} was merging; FF already landed, finalized to done`,
      )
      if (t.worktreePath && exists(t.worktreePath)) {
        await removeWorktree({ path: t.worktreePath, branch }, true).catch(() => {})
      }
      await updateTask(t.id, {
        status: 'done',
        failedPhase: null,
        error: null,
      }).catch(() => {})
      summary.mergingFinalized++
    } else {
      if (t.worktreePath && exists(t.worktreePath)) {
        await removeWorktree({ path: t.worktreePath, branch }, true).catch(() => {})
      }
      await exec('git', ['branch', '-D', branch], { cwd: getRepoRoot() }).catch(() => {})
      const mergingHasBlockers = await hasIncompleteBlockers(t.id).catch(() => false)
      if (mergingHasBlockers) {
        log(
          `[reconcile] task ${t.id} was merging; FF not landed, has incomplete blockers, restored to blocked`,
        )
        await updateTask(t.id, {
          status: 'blocked',
          branch: null,
          worktreePath: null,
          claudeSessionId: null,
          error: null,
          failedPhase: null,
        }).catch(() => {})
      } else {
        log(
          `[reconcile] task ${t.id} was merging; FF not landed, requeued from setup`,
        )
        await updateTask(t.id, {
          status: 'queued',
          branch: null,
          worktreePath: null,
          claudeSessionId: null,
          error: null,
          failedPhase: null,
        }).catch(() => {})
        bus.emit('task.queued', { taskId: t.id })
        summary.mergingRequeued++
      }
    }
  }

  // ── 9. Stalled-proposal slice ───────────────────────────────────────────────
  // Proposals promoted while the daemon was offline are still in prd-ready.
  // When a handleProposalSlice callback is provided (daemon path), slice them.
  // When null (standalone path), just report them — the operator must start
  // the daemon to dispatch them.
  try {
    const stalled = await listProposals({ status: 'prd-ready' })
    summary.stalledProposalsSliced = stalled.length
    for (const proposal of stalled) {
      if (handleProposalSlice !== null) {
        log(`[reconcile-slice] proposal ${proposal.id} prd-ready on startup; slicing`)
        void handleProposalSlice(proposal.id).catch((err) =>
          log(`[reconcile-slice] proposal ${proposal.id} failed: ${(err as Error).message}`),
        )
      } else {
        log(
          `[reconcile-slice] proposal ${proposal.id} is prd-ready but no dispatch loop available; start the daemon to slice`,
        )
      }
    }
  } catch (err) {
    log(`[reconcile-slice] failed: ${(err as Error).message}`)
  }

  return summary
}
