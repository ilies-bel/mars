/**
 * reconcilers — the ordered registry of startup reconciliation steps.
 *
 * Each entry is a `Reconciler` (see ./reconciler.ts) that wraps an existing
 * reconcile function or a previously-inlined block from startup-reconcile.ts.
 * The function BODIES are unchanged; only their signatures are adapted to
 * `run(deps): Promise<ReconcileStepResult>`. The order of `RECONCILERS` is
 * the exact startup sequence — see the ordering contract on
 * `runStartupReconcile`.
 *
 * The dynamic `import(...)` calls inside several `run` bodies are preserved
 * verbatim from the original inline steps: they keep startup-reconcile's lazy
 * load behaviour (modules are only resolved when the step actually runs) and
 * avoid pulling git/fs/proposal machinery into the module graph of callers
 * that never reach those steps (e.g. the standalone `mars sync` path).
 */

import { listTasks } from '../queue'
import { listProposals } from '../proposals'
import { sweepOrphanRunningSpans } from '../lib/trace-events-store'
import { Arc } from '../arc'
import type { Reconciler } from './reconciler'

/**
 * 1. Daemon-killed sweep — raise alert-only action queue items for tasks that
 *    were SIGKILL'd with a prior daemon; do NOT auto-requeue them.
 */
const daemonKilledSweep: Reconciler = {
  name: 'daemon-killed-sweep',
  async run({ log }) {
    try {
      const { detectAndRaiseDaemonKilled } = await import('./daemon-killed-sweep')
      const raised = await detectAndRaiseDaemonKilled()
      if (raised.length > 0) {
        log(
          `[reconcile] raised ${raised.length} daemon-killed alert(s) (alert-only; not auto-requeued)`,
        )
      }
      return { daemonKilledAlerts: raised.length }
    } catch (err) {
      log(`[reconcile] daemon-killed sweep failed: ${(err as Error).message}`)
      return {}
    }
  },
}

/**
 * 2. Blocker-drift repair — demote any `queued` task that still has incomplete
 *    blockers back to `blocked` BEFORE we re-seed the dispatch queue.
 */
const blockerDriftRepair: Reconciler = {
  name: 'blocker-drift-repair',
  async run({ log }) {
    try {
      const { repairQueuedWithIncompleteBlockers } = await import('./reconcile-blocker-drift')
      const demoted = await repairQueuedWithIncompleteBlockers()
      for (const taskId of demoted) {
        log(
          `[reconcile] BUG: task ${taskId} was queued with incomplete blockers — demoted to blocked`,
        )
      }
      return { blockerDriftRepaired: demoted.length }
    } catch (err) {
      log(`[reconcile] blocker-drift repair failed: ${(err as Error).message}`)
      return {}
    }
  },
}

/**
 * 3. Orphaned-blocked scan — re-queue any `blocked` task whose blocker edges
 *    have all resolved or been removed (the zero-edge orphan case). Must run
 *    AFTER drift repair so we don't promote a task that was demoted in step 2.
 */
const orphanedBlockedScan: Reconciler = {
  name: 'orphaned-blocked-scan',
  async run({ log, bus }) {
    try {
      const { outcomes } = await Arc.recoverAllBlocked()
      const requeued = outcomes.filter((o) => o.outcome === 'queued')
      for (const o of requeued) {
        log(`[reconcile] task ${o.taskId} orphaned-blocked; re-queued`)
        bus.emit('task.queued', { taskId: o.taskId })
      }
      return { orphanedBlockedRequeued: requeued.length }
    } catch (err) {
      log(`[reconcile] orphaned-blocked scan failed: ${(err as Error).message}`)
      return {}
    }
  },
}

/**
 * 4. Reseed dispatch — emit task.added / task.queued for all draft/queued rows
 *    so the dispatch loop picks them up. Pure bus side-effect; no summary
 *    contribution.
 */
const reseedDispatch: Reconciler = {
  name: 'reseed-dispatch',
  async run({ bus }) {
    const drafts = await listTasks('draft')
    for (const t of drafts) bus.emit('task.added', { taskId: t.id })

    const queued = await listTasks('queued')
    for (const t of queued) bus.emit('task.queued', { taskId: t.id })

    return {}
  },
}

/**
 * 5. Requeue stale-running — tasks that were `running` when the prior daemon
 *    died are re-queued from setup (no retry budget burn).
 */
const requeueStaleRunning: Reconciler = {
  name: 'requeue-stale-running',
  async run({ log, bus }) {
    const { requeueRunningTasksFromPriorDaemon } = await import('./reconcile-running')
    const { getRepoRoot } = await import('../context')
    const requeued = await requeueRunningTasksFromPriorDaemon(getRepoRoot())
    for (const taskId of requeued) {
      log(`[reconcile] task ${taskId} was running on prior daemon; requeued from setup`)
      bus.emit('task.queued', { taskId })
    }
    return { runningRequeued: requeued.length }
  },
}

/**
 * 6. Orphan span sweep — mark any unclosed step spans from prior daemons as
 *    killed. Skipped when `traceStore` is unavailable (standalone path).
 */
const orphanSpanSweep: Reconciler = {
  name: 'orphan-span-sweep',
  async run({ log, traceStore }) {
    if (traceStore === null) return {}
    try {
      const swept = await sweepOrphanRunningSpans(traceStore)
      if (swept > 0) {
        log(`[reconcile] swept ${swept} orphan running span(s) to killed`)
      }
      return { orphanSpansSwept: swept }
    } catch (err) {
      log(`[reconcile] orphan span sweep failed: ${(err as Error).message}`)
      return {}
    }
  },
}

/**
 * 7. Verifying recovery — if the worktree survives, clear and re-queue (or
 *    restore to blocked when incomplete blockers exist); else mark failed.
 *    Delegates to the shared `recoverPhase` loop.
 */
const verifyingRecovery: Reconciler = {
  name: 'verifying-recovery',
  async run({ log, bus }) {
    const { recoverPhase } = await import('./phase-recovery')
    const { getRepoRoot } = await import('../context')
    const r = await recoverPhase('verifying', { log, bus, repoRoot: getRepoRoot() })
    return { verifyingRequeued: r.requeued.length, verifyingFailed: r.failed }
  },
}

/**
 * 8. Merging recovery — if the FF already landed, finalize to done; else clear
 *    worktree and re-queue (or restore to blocked when incomplete blockers
 *    exist). Delegates to the shared `recoverPhase` loop.
 */
const mergingRecovery: Reconciler = {
  name: 'merging-recovery',
  async run({ log, bus }) {
    const { recoverPhase } = await import('./phase-recovery')
    const { getRepoRoot } = await import('../context')
    const r = await recoverPhase('merging', { log, bus, repoRoot: getRepoRoot() })
    return { mergingFinalized: r.finalized, mergingRequeued: r.requeued.length }
  },
}

/**
 * 9. Stalled-proposal slice — pick up prd-ready proposals promoted while the
 *    daemon was offline. With a `handleProposalSlice` callback (daemon path),
 *    slice them; when null (standalone path), just report them.
 */
const stalledProposalSlice: Reconciler = {
  name: 'stalled-proposal-slice',
  async run({ log, handleProposalSlice }) {
    try {
      const stalled = await listProposals({ status: 'prd-ready' })
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
      return { stalledProposalsSliced: stalled.length }
    } catch (err) {
      log(`[reconcile-slice] failed: ${(err as Error).message}`)
      return {}
    }
  },
}

/**
 * The ordered startup-reconcile registry. Order is load-bearing and matches
 * the historical hand-called sequence 1→9. To add a step, insert a
 * `Reconciler` at the correct position; the boot path iterates this array.
 */
export const RECONCILERS: readonly Reconciler[] = [
  daemonKilledSweep,
  blockerDriftRepair,
  orphanedBlockedScan,
  reseedDispatch,
  requeueStaleRunning,
  orphanSpanSweep,
  verifyingRecovery,
  mergingRecovery,
  stalledProposalSlice,
]
