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
 * deliberately NOT a member of this registry. It runs in a different boot
 * phase — inside the alert-dismisser IIFE, after `ensureAlertDismisser`,
 * gated on a libsql `Client` rather than `ReconcileDeps`, and concerns
 * action-queue resolution rather than task-status recovery. Folding it into
 * the startup sequence would change *when* it runs relative to the
 * alert-dismisser drain, so it stays a standalone call. See the comment at
 * its server.ts call site.
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
  blockerDriftRepaired: 0,
  orphanedBlockedRequeued: 0,
  runningRequeued: 0,
  orphanSpansSwept: 0,
  verifyingRequeued: 0,
  verifyingFailed: 0,
  mergingFinalized: 0,
  mergingRequeued: 0,
  stalledProposalsSliced: 0,
})
