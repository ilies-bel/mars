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
import { getDefaultDomainTaskStore } from '../store/task-store'
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
 * 2. Daemon-died sweep — raise a `daemon-died` action-queue alert when the
 *    previous daemon run exited uncleanly (crash, OOM, SIGKILL, or any path
 *    that bypassed the `shutdown()` cleanup). The crash marker file is written
 *    by `startDaemon` at startup when it detects a stale running marker from the
 *    prior run. Does NOT modify task status — alert only.
 */
const daemonDiedSweep: Reconciler = {
  name: 'daemon-died-sweep',
  async run({ log }) {
    try {
      const { daemonPaths } = await import('./paths')
      const { detectAndRaiseDaemonDied } = await import('./daemon-died-sweep')
      const { crashMarker } = daemonPaths()
      const raised = await detectAndRaiseDaemonDied(crashMarker)
      if (raised !== null) {
        log('[reconcile] daemon-died alert raised (previous daemon exited uncleanly)')
      }
      return { daemonDiedAlerts: raised !== null ? 1 : 0 }
    } catch (err) {
      log(`[reconcile] daemon-died sweep failed: ${(err as Error).message}`)
      return {}
    }
  },
}

/**
 * 2b. Orphaned-chat-run sweep — flip any `chat_threads` row still at
 *     `status='running'` to `'idle'` and append an interrupted-run assistant
 *     message. On daemon start the in-memory run map is empty, so any
 *     `'running'` row is by definition an orphan from a prior crash/restart and
 *     can never finish on its own.
 */
const orphanedChatRunSweep: Reconciler = {
  name: 'orphaned-chat-run-sweep',
  async run({ log }) {
    try {
      const { recoverOrphanedChatRuns } = await import('../lib/chat-store')
      const recovered = await recoverOrphanedChatRuns()
      if (recovered > 0) {
        log(
          `[reconcile] flipped ${recovered} orphaned chat thread(s) from 'running' to 'idle' (daemon restart)`,
        )
      }
      return { orphanedChatRunsRecovered: recovered }
    } catch (err) {
      log(`[reconcile] orphaned-chat-run-sweep failed: ${(err as Error).message}`)
      return {}
    }
  },
}

/**
 * 3. Blocker-drift repair — demote any `queued` task that still has incomplete
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
 * 4. Recovery-done propagation — replay any completed recovery (kind='fix',
 *    status='done') whose origin task was never flipped to 'done'. This
 *    covers the case where the task.completed outbox event was not delivered
 *    to the subscriber that runs the propagate block in server.ts (e.g. a
 *    daemon crash between the FF-merge commit and outbox drain). Without this
 *    step a missed event strands the origin in 'failed'/'blocked' and its
 *    dependents permanently in 'blocked', because the old startup-reconcile
 *    pass had no rule for this scenario and a daemon restart did not clear it.
 *
 *    Idempotent: propagateRecoveryDone() is a no-op when the origin is
 *    already 'done'. Error semantics: swallows its own errors (like steps
 *    1–3) so a transient DB hiccup does not abort the rest of the pass.
 */
const recoveryDonePropagation: Reconciler = {
  name: 'recovery-done-propagation',
  async run({ log, bus }) {
    try {
      const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import('../lib/main-dirty')
      const doneFixes = await getDefaultDomainTaskStore().listDoneFixTasks()

      let propagated = 0
      let requeued = 0
      for (const fix of doneFixes) {
        // Guard: main-committer recoveries clean the integration branch but do
        // NOT deliver the origin task's work. Re-queue source tasks via
        // releaseMainCommitterDependents instead of marking the origin done.
        // (Bug mars-4d66145d: no-op main-committer falsely marked origin done
        // and cascade-unblocked dependents before the work shipped.)
        if (parseMainCommiterPayload(fix.recoveryPayload)?.recipe === MAIN_COMMITER_RECIPE) {
          const release = await Arc.releaseMainCommitterDependents(fix.id, log)
          requeued += release.released
          continue
        }

        const result = await Arc.load(fix.fixForTaskId!).propagateRecoveryDone()
        if (result.originFlipped) {
          log(
            `[reconcile] recovery ${fix.id} propagated done to origin ${result.originTaskId}; closed ${result.actionQueueItemsClosed} actionQueue item(s)`,
          )
          propagated++
          if (result.unblock) {
            for (const o of result.unblock.outcomes) {
              if (o.outcome === 'queued') {
                log(
                  `[reconcile] task ${o.taskId} re-queued after recovery propagated done to origin ${result.originTaskId}`,
                )
                bus.emit('task.queued', { taskId: o.taskId })
                requeued++
              }
            }
          }
        }
      }
      return { recoveryPropagated: propagated, recoveryDependentsRequeued: requeued }
    } catch (err) {
      log(`[reconcile] recovery-done-propagation failed: ${(err as Error).message}`)
      return {}
    }
  },
}

/**
 * 5b. Failed-committer dependent release — replay the on-failure fan-out for
 *     `main-commiter` recoveries whose in-line `updateTaskWithEvents` handler
 *     was interrupted (a crash, or a DB deadlock whose error was swallowed by
 *     the handler's try/catch) so its dependents were never released.
 *
 *     Symmetric to `recovery-done-propagation` but for the FAILED committer
 *     case: for every failed `main-commiter` fix task that STILL has `blocked`
 *     dependents, refresh the aggregated action-queue row and call
 *     `releaseMainCommitterDependents` — which keeps dependents blocked while
 *     the integration branch is dirty and only re-queues them once it is clean.
 *
 *     Why this gap exists: the on-spawn rescue
 *     (`reparentStrandedDependentsOntoNewCommitter`) only fires when a NEW
 *     committer spawns, which never happens once main goes clean (no task hits
 *     dirty-main). So a committer that failed mid-fan-out over a since-cleaned
 *     main strands its dependents permanently with no path forward. Incident
 *     2026-07-23: a deadlock storm swallowed the on-failure release and left 18
 *     tasks blocked on a dead committer.
 *
 *     Idempotent: both helpers no-op when there is nothing to do (no blocked
 *     dependents / dirty main / already-raised row). Swallows its own errors
 *     (like steps 1–5) so a transient DB hiccup does not abort the rest of the
 *     pass. Must run BEFORE reseed-dispatch so freshly re-queued dependents are
 *     picked up by the same boot's dispatch reseed.
 */
const failedCommitterDependentRelease: Reconciler = {
  name: 'failed-committer-dependent-release',
  async run({ log }) {
    try {
      const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
        '../lib/main-dirty'
      )
      const { releaseMainCommitterDependents, raiseAggregatedMainCommiterFailureRow } =
        await import('./main-dirty-action-queue')
      const { getRepoRoot } = await import('../context')
      const store = getDefaultDomainTaskStore()

      // Failed fix tasks that still have at least one `blocked` dependent.
      // The main-commiter filter is applied per-row below (recovery_payload is
      // the only reliable committer marker).
      const r = await store.query({
        sql: `SELECT DISTINCT t.id AS id, t.recovery_payload AS recovery_payload
                FROM tasks t
                JOIN task_blockers tb ON tb.blocker_task_id = t.id
                JOIN tasks dep ON dep.id = tb.task_id
               WHERE t.kind = 'fix'
                 AND t.status = 'failed'
                 AND dep.status = 'blocked'`,
      })

      let processed = 0
      for (const row of r.rows as unknown as Array<{
        id: string
        recovery_payload: string | null
      }>) {
        if (
          parseMainCommiterPayload(row.recovery_payload)?.recipe !==
          MAIN_COMMITER_RECIPE
        ) {
          continue
        }
        // Replay the interrupted on-failure fan-out. Both calls are idempotent
        // and independently guarded, so a failure in one must not skip the other.
        try {
          await raiseAggregatedMainCommiterFailureRow(row.id, log)
        } catch (rowErr) {
          log(
            `[reconcile] failed-committer ${row.id}: aggregated action-queue refresh errored: ${(rowErr as Error).message}`,
          )
        }
        try {
          await releaseMainCommitterDependents(row.id, log, getRepoRoot())
        } catch (rowErr) {
          log(
            `[reconcile] failed-committer ${row.id}: dependent release errored: ${(rowErr as Error).message}`,
          )
        }
        processed++
      }
      if (processed > 0) {
        log(
          `[reconcile] failed-committer-dependent-release: processed ${processed} failed main-commiter(s) with blocked dependents`,
        )
      }
      return {}
    } catch (err) {
      log(
        `[reconcile] failed-committer-dependent-release failed: ${(err as Error).message}`,
      )
      return {}
    }
  },
}

/**
 * 5. Requeue stale-running — tasks that were `running` when the prior daemon
 *    died are re-queued from setup (no retry budget burn). Must run BEFORE
 *    reseed-dispatch so that orphaned 'running' rows are converted to 'queued'
 *    before the dispatch loop re-seeds from all 'queued' rows. Running this
 *    after reseed-dispatch risks the dispatch loop picking up a row that is
 *    still tagged 'running' in the DB, skipping it (drain guards `t.status !==
 *    'queued'`), and leaving it stranded until the phantom-task watchdog fires.
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
 * 6. Reseed dispatch — emit task.added / task.queued for all draft/queued rows
 *    so the dispatch loop picks them up. Pure bus side-effect; no summary
 *    contribution. Must run AFTER requeue-stale-running (step 5) so that any
 *    prior-daemon 'running' rows have already been converted to 'queued' before
 *    this step seeds the dispatch queue.
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
 * 7. Orphan span sweep — mark any unclosed step spans from prior daemons as
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
 * 8. Verifying recovery — if the worktree survives, clear and re-queue (or
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
 * 9. Merging recovery — if the FF already landed, finalize to done; else clear
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
 * 9b. Vega-reconciling recovery — tasks that were running the vcs-supervisor
 *     (Vega) when the prior daemon died. Vega's subprocess is dead; the
 *     worktree may be in an unknown state (partial rebase, mid-conflict). The
 *     recovery always discards the worktree and requeues from setup, unless
 *     the branch already landed in the integration branch (finalize to done).
 *     Must run AFTER merging-recovery (same lifecycle phase) and BEFORE
 *     reseed-dispatch so freshly-requeued tasks are included in the boot seed.
 */
const vegaReconcilingRecovery: Reconciler = {
  name: 'vega-reconciling-recovery',
  async run({ log, bus }) {
    const { recoverPhase } = await import('./phase-recovery')
    const { getRepoRoot } = await import('../context')
    const r = await recoverPhase('vega-reconciling', { log, bus, repoRoot: getRepoRoot() })
    return { vegaReconcilingRequeued: r.requeued.length, vegaReconcilingFinalized: r.finalized }
  },
}

/**
 * 10. Stalled-proposal slice — pick up prd-ready proposals promoted while the
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
 * 11. Stale action-queue sweep — resolve any open action-queue items whose
 *     origin task has already reached a terminal-success state (`done` or
 *     `dropped`) but whose alert row was not closed by the normal event-driven
 *     path (e.g. the alert-dismisser outbox subscriber did not drain before the
 *     daemon was restarted, or the task transitioned to done via a code path
 *     that skipped the usual dismissal event).
 *
 *     Runs AFTER the task-status recovery steps (1–10) so that tasks flipped to
 *     `done` by step 4 (recovery-done-propagation) are also covered.
 *
 *     This step is belt-and-suspenders alongside the `reconcileTerminalTasks`
 *     call in the alert-dismisser boot IIFE (server.ts).  Both paths are
 *     idempotent; whichever runs first closes the rows and the second is a
 *     no-op.  The daemon's IIFE call (tied to `ensureAlertDismisser` / before
 *     `drainAlertDismissals`) is still present for the timing-sensitive path;
 *     this step covers the standalone `mars sync` path and provides an extra
 *     safety net at startup.
 */
const staleActionQueueSweep: Reconciler = {
  name: 'stale-action-queue-sweep',
  async run({ log }) {
    try {
      // TODO(mars-8a44f22d): reconcileTerminalTasks currently requires a raw
      // Client. Convert its API to accept a DomainTaskStore so this dynamic
      // resolveQueueClient() import can be retired.
      const { resolveQueueClient } = await import('../queue')
      const { reconcileTerminalTasks } = await import('./lifecycle-reconcile')
      const { rowsResolved } = await reconcileTerminalTasks(resolveQueueClient())
      if (rowsResolved > 0) {
        log(
          `[reconcile] stale-action-queue-sweep: resolved ${rowsResolved} stale action-queue item(s) for done/dropped tasks`,
        )
      }
      return { staleActionQueueItemsResolved: rowsResolved }
    } catch (err) {
      log(`[reconcile] stale-action-queue-sweep failed: ${(err as Error).message}`)
      return {}
    }
  },
}

/**
 * 12. Code-drift clear sweep — resolve any open `daemon-code-drift` action-queue
 *    rows left over from a previous daemon process. A code-drift row reflects
 *    "this daemon is running stale code"; once the daemon restarts it is running
 *    current code, so any residual open row is stale and should be cleared.
 *    Runs before the staleness interval is armed so the freshly started daemon
 *    never inherits a false-positive drift alert. Errors are swallowed so a DB
 *    hiccup does not abort the rest of the pass.
 */
const codeDriftClearSweep: Reconciler = {
  name: 'code-drift-clear-sweep',
  async run({ log }) {
    try {
      const { supersedeActionQueueItemsBySignature } = await import('../lib/action-queue')
      const closed = await supersedeActionQueueItemsBySignature(
        'daemon-code-drift',
        'daemon-code-drift',
        'daemon-restarted',
        'daemon:restart',
      )
      if (closed.length > 0) {
        log(`[reconcile] cleared ${closed.length} stale daemon-code-drift alert(s) on restart`)
      }
      return { codeDriftAlertsCleared: closed.length }
    } catch (err) {
      log(`[reconcile] code-drift-clear-sweep failed: ${(err as Error).message}`)
      return {}
    }
  },
}

/**
 * 13. Ghost-subscriber sweep — delete rows from the `subscribers` table whose
 *    name is not among the currently code-declared subscribers, together with
 *    any matching rows in `subscriber_processed_events`. A ghost row is a
 *    subscriber that was renamed or removed from the codebase; its stale cursor
 *    lags the outbox head forever and produces spurious `subscriber-stalled`
 *    action-queue noise (ADR-0032). Subscribers are code-declared (ADR-0031),
 *    so the set of legitimate names is known at boot. Errors are swallowed so
 *    a DB hiccup does not abort the rest of the pass.
 */
const ghostSubscriberSweep: Reconciler = {
  name: 'ghost-subscriber-sweep',
  async run({ log }) {
    try {
      // TODO(mars-8a44f22d): ghostSubscriberSweep queries the `subscribers`
      // table and catalog metadata which are below the task-domain seam. Add a
      // `listGhostSubscribers(knownNames)` typed method to DomainTaskStore (or a
      // separate SubscriberStore) to retire this resolveQueueClient() usage.
      const { resolveQueueClient } = await import('../queue')
      const { knownSubscriberNames } = await import('../../outbox/registry')

      // knownSubscriberNames() is populated by module-level registerSubscriberName()
      // calls in each subscriber module. Those modules are imported during daemon
      // startup before the reconcile pass runs. Tests that exercise this sweep must
      // import the subscriber modules themselves to mirror that ordering.
      const knownNames = knownSubscriberNames()

      const client = resolveQueueClient()

      // If the subscribers table doesn't exist yet, there are no ghosts to sweep.
      const tableCheck = await client.execute(
        `SELECT to_regclass('public.subscribers') AS reg`,
      )
      if (tableCheck.rows[0]?.reg == null) return {}

      const allRows = await client.execute('SELECT name FROM subscribers')
      const ghosts = allRows.rows
        .map((r) => r.name as string)
        .filter((name) => !knownNames.has(name))

      if (ghosts.length === 0) return { ghostSubscribersSwept: 0 }

      // Check if subscriber_processed_events table exists before attempting to
      // delete from it (belt-and-suspenders for pre-ensureSchema stores).
      const speCheck = await client.execute(
        `SELECT to_regclass('public.subscriber_processed_events') AS reg`,
      )
      const hasSPE = speCheck.rows[0]?.reg != null

      for (const name of ghosts) {
        if (hasSPE) {
          await client.execute({
            sql: 'DELETE FROM subscriber_processed_events WHERE subscriber_id = ?',
            args: [name],
          })
        }
        await client.execute({
          sql: 'DELETE FROM subscribers WHERE name = ?',
          args: [name],
        })
        log(
          `[reconcile] ghost-subscriber-sweep: removed stale subscriber '${name}' (no longer code-declared)`,
        )
      }

      return { ghostSubscribersSwept: ghosts.length }
    } catch (err) {
      log(`[reconcile] ghost-subscriber-sweep failed: ${(err as Error).message}`)
      return {}
    }
  },
}

/**
 * The ordered startup-reconcile registry. Order is load-bearing and matches
 * the historical hand-called sequence 1→10. To add a step, insert a
 * `Reconciler` at the correct position; the boot path iterates this array.
 */
export const RECONCILERS: readonly Reconciler[] = [
  daemonKilledSweep,
  daemonDiedSweep,
  orphanedChatRunSweep,
  blockerDriftRepair,
  orphanedBlockedScan,
  recoveryDonePropagation,
  failedCommitterDependentRelease,
  requeueStaleRunning,
  reseedDispatch,
  orphanSpanSweep,
  verifyingRecovery,
  mergingRecovery,
  vegaReconcilingRecovery,
  stalledProposalSlice,
  staleActionQueueSweep,
  codeDriftClearSweep,
  ghostSubscriberSweep,
]
