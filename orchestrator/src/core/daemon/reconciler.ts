/**
 * reconciler — the single seam for daemon startup reconciliation.
 *
 * Before this seam existed, "reconciliation" was a concept fragmented across
 * four single-function files (reconcile-blocker-drift, reconcile-running,
 * lifecycle-reconcile) plus a handful of steps inlined directly in
 * startup-reconcile.ts, each hand-called in sequence. Adding or reordering a
 * recovery step meant editing the boot orchestrator in place.
 *
 * This module defines:
 *  - `ReconcileDeps`     — what every step is allowed to touch (log, bus,
 *                          optional trace store, optional proposal-slice cb);
 *  - `ReconcileStepResult` — the partial contribution a step makes to the
 *                          aggregate `ReconcileSummary` (steps that have no
 *                          numeric report return `{}`);
 *  - `Reconciler`        — a named step with a `run(deps)` method;
 *  - `RECONCILERS`       — the ordered registry the boot path iterates.
 *
 * The step BODIES are unchanged: each entry wraps the existing reconcile
 * function (or the previously-inlined block) verbatim and only adapts the
 * signature to the interface. Order in `RECONCILERS` is load-bearing — it is
 * the exact startup sequence and must not be reshuffled without checking the
 * ordering contract documented on `runStartupReconcile`.
 *
 * NOTE on scope: `reconcileTerminalTasks` (lifecycle-reconcile.ts) is
 * invoked from TWO places:
 *   1. The `stale-action-queue-sweep` registry step (step 11) — runs as part
 *      of the normal startup reconcile pass. This is the primary safety net and
 *      also covers the standalone `mars sync` path.
 *   2. The alert-dismisser boot IIFE in server.ts — runs after
 *      `ensureAlertDismisser` and before `drainAlertDismissals`. This path is
 *      retained for timing-sensitive daemon-only cleanup (closing rows before
 *      the outbox drain so the drain never sees a stale open row that should
 *      already be resolved). Both paths are idempotent; whichever runs first
 *      closes the rows and the second is a no-op.
 */

import type { EventEmitter } from 'node:events'
import type { TraceEventStore } from '../lib/trace-events-store'

/**
 * Everything a reconcile step is permitted to touch. Carried unchanged from
 * the previous `StartupReconcileDeps` so the existing call sites and the
 * `mars sync` RPC keep their contract.
 */
export interface ReconcileDeps {
  log: (line: string) => void
  bus: EventEmitter
  /**
   * TraceEventStore for orphan span sweeping. `null` when the store is not
   * available (standalone / no-daemon path) — span sweep is skipped.
   */
  traceStore: TraceEventStore | null
  /**
   * Proposal-slicing callback. `null` when there is no dispatch loop
   * (standalone path) — stalled prd-ready proposals are detected and logged
   * but not sliced.
   */
  handleProposalSlice: ((proposalId: string) => Promise<unknown>) | null
}

/**
 * The aggregate report produced by a full reconcile pass. Each numeric field
 * is contributed by exactly one step. Kept identical to the historical
 * `ReconcileSummary` shape so `mars sync` callers and tests are unaffected.
 */
export interface ReconcileSummary {
  daemonKilledAlerts: number
  /** Action-queue items raised (or bumped) for unclean daemon exits. */
  daemonDiedAlerts: number
  blockerDriftRepaired: number
  /**
   * Origins flipped from `blocked` to `failed` because the one recovery Chore
   * they were waiting on had itself failed (ADR-0040: a recovery is a leaf and
   * is never re-run, so the edge can never resolve). Heals rows stranded before
   * the live path existed, or by a crash between the recovery's failure and the
   * blocker-resolution subscriber draining.
   */
  strandedOriginsFailed: number
  /** Chores dropped because their origin had already reached a terminal state. */
  terminalOriginChoresDropped: number
  /** Tasks flipped from blocked→queued because they had zero live blocker edges. */
  orphanedBlockedRequeued: number
  runningRequeued: number
  orphanSpansSwept: number
  verifyingRequeued: number
  verifyingFailed: number
  mergingFinalized: number
  mergingRequeued: number
  /**
   * Tasks in `vega-reconciling` status whose Vega (vcs-supervisor) session died
   * with the daemon and that were requeued from setup at startup.
   */
  vegaReconcilingRequeued: number
  /**
   * Tasks in `vega-reconciling` status whose fast-forward had already landed
   * before the daemon died; finalized to `done` at startup.
   */
  vegaReconcilingFinalized: number
  stalledProposalsSliced: number
  /**
   * Origins flipped to 'done' by replaying a completed recovery's propagation
   * at startup. Covers the case where the task.completed event for the fix task
   * was never delivered (daemon crash between FF-merge and outbox delivery).
   */
  recoveryPropagated: number
  /**
   * Dependents re-queued as a downstream effect of a recovery-done propagation
   * replayed during startup reconcile.
   */
  recoveryDependentsRequeued: number
  /**
   * Open action-queue items resolved because the task they referenced has
   * since reached a terminal-success state (`done` or `dropped`). Covers
   * the gap where the alert-dismisser outbox subscriber did not drain
   * fast enough before the next daemon restart, or where the task transitioned
   * to done via a code path that did not emit the expected dismissal event.
   */
  staleActionQueueItemsResolved: number
  /**
   * Open `daemon-code-drift` action-queue rows cleared at daemon startup.
   * A drift row from a prior daemon run is stale once the daemon restarts
   * (the new daemon is running current code). This count is normally 0 or 1.
   */
  codeDriftAlertsCleared: number
  /** Workflow-install drift rows raised or closed at startup. */
  workflowInstallAlertsReconciled: number
  /**
   * Subscriber rows deleted from the `subscribers` table (and their
   * `subscriber_processed_events` rows) because their name no longer
   * matches any code-declared subscriber. A non-zero count indicates a
   * ghost row left over from a renamed or removed subscriber.
   */
  ghostSubscribersSwept: number
  /**
   * Chat threads whose status was 'running' at daemon start (orphaned by a
   * prior crash/restart) and were flipped to 'idle' with an interrupted-run
   * assistant message so the user sees why their turn produced no reply.
   */
  orphanedChatRunsRecovered: number
  /** Retired planning-gate rows closed at startup. */
  retiredPlanGateRowsCleared: number
  /** Legacy proposal children released from draft status at startup. */
  legacySlicedDraftsReleased: number
  /**
   * Idle chat threads with no user messages that were evaporated by the
   * dead-thread eviction sweep at daemon start.
   */
  deadThreadsEvaporated: number
  /**
   * Stale `main-commiter` fix tasks in `queued` status with `blocked`
   * dependents that were re-seeded via `task.queued` so the dispatch loop
   * picks them up without waiting for the next daemon restart.
   */
  queuedCommittersReseeded: number
  /**
   * `merge_jobs` rows in `claimed` or `running` status that were reset back to
   * `queued` (with `attempts` incremented) at daemon startup. A non-zero count
   * indicates the prior daemon died while a merge was in-flight.
   */
  mergeJobsReset: number
  /**
   * New `merge_jobs` rows created at daemon startup for tasks in `merging`
   * status that had no active (queued/claimed/running) job row. Covers the gap
   * where the daemon died after setting `task.status='merging'` but before
   * inserting the merge_jobs row.
   */
  mergeJobsRebuilt: number
}

/**
 * A step's contribution to the aggregate summary. A `Partial` so steps only
 * report the field(s) they own; steps with no numeric report (e.g. the
 * dispatch-reseed) return `{}`.
 */
export type ReconcileStepResult = Partial<ReconcileSummary>

/**
 * A single reconciliation step. `name` is for logging and the ordering
 * contract; `run` performs the step against `deps` and returns its summary
 * contribution. A step that throws is caught by the orchestrator (a failing
 * step must never abort the rest of the pass) unless it intentionally
 * propagates.
 */
export interface Reconciler {
  name: string
  run(deps: ReconcileDeps): Promise<ReconcileStepResult>
}

/** A fresh, all-zero summary used as the merge target for step results. */
export const emptyReconcileSummary = (): ReconcileSummary => ({
  daemonKilledAlerts: 0,
  daemonDiedAlerts: 0,
  blockerDriftRepaired: 0,
  strandedOriginsFailed: 0,
  terminalOriginChoresDropped: 0,
  orphanedBlockedRequeued: 0,
  runningRequeued: 0,
  orphanSpansSwept: 0,
  verifyingRequeued: 0,
  verifyingFailed: 0,
  mergingFinalized: 0,
  mergingRequeued: 0,
  vegaReconcilingRequeued: 0,
  vegaReconcilingFinalized: 0,
  stalledProposalsSliced: 0,
  recoveryPropagated: 0,
  recoveryDependentsRequeued: 0,
  staleActionQueueItemsResolved: 0,
  codeDriftAlertsCleared: 0,
  workflowInstallAlertsReconciled: 0,
  ghostSubscribersSwept: 0,
  orphanedChatRunsRecovered: 0,
  retiredPlanGateRowsCleared: 0,
  legacySlicedDraftsReleased: 0,
  deadThreadsEvaporated: 0,
  queuedCommittersReseeded: 0,
  mergeJobsReset: 0,
  mergeJobsRebuilt: 0,
})
