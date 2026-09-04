// GENERATED — do not edit by hand.
// Regenerate with: npm --prefix orchestrator run mars:gen:ui-kinds
//
// Source of truth:
//   orchestrator/src/core/lib/action-queue-kinds.ts  (DERIVED_KINDS, ACTION_QUEUE_KINDS)
//   orchestrator/src/core/daemon/view/action-queue.ts (NON_TASK_FAILURE_KINDS)
//
// conditionKinds.driftGate.test.ts and taskFailureKinds.driftGate.test.ts assert
// that this file's constants match the orchestrator sources exactly.

/**
 * Mirror of DERIVED_KINDS from orchestrator/src/core/lib/action-queue-kinds.ts.
 *
 * Derived kinds are derived on read from live system state — there is no stored
 * row to close. Whether a derived-kind row survives a verb depends entirely on
 * whether the underlying condition still holds after the verb. DO NOT optimistically
 * hide derived-kind rows on verb success; let the refetched feed decide.
 */
export const conditionKinds = [
  'failed',
  'stale-queued',
  'stale-queued-summary',
  'gate-broken',
  'subscriber-stalled',
  'signature-storm',
  'signature-wave',
  'daemon-died',
  'daemon-code-drift',
  'baseline-broken',
  'stale-worktree',
  'phantom-task',
  'worktree-ahead',
  'orphaned-origin',
  'steward-repeat',
  'e2e-tooling-missing',
  'phantom-merge',
  'phantom-merge-unknown',
] as const

/**
 * Mirror of ACTION_QUEUE_KINDS minus NON_TASK_FAILURE_KINDS from
 * orchestrator/src/core/daemon/view/action-queue.ts.
 *
 * Every action-queue kind NOT in NON_TASK_FAILURE_KINDS is classified as a task
 * failure. This list backs the `taskFailureItemSchema` z.enum in schemas.ts —
 * adding a kind here changes how rows parse, not just how they group.
 */
export const taskFailureKinds = [
  'failed',
  'steward-repeat',
  'cancelled-blocker-cascade',
  'diagnose-inconclusive',
  'daemon-killed',
  'coder-question',
  'daemon-died',
  'worktree-ahead',
  'prerequisite-failed',
  'slices-dropped',
  'slice-failed',
  'behaviour-unverified',
  'subscriber-stalled',
  'observability-store-oversize',
  'orphaned-origin',
  'phantom-task',
  'outbox-lag',
  'done-with-unmerged-commits',
  'api-outage',
  'daemon-code-drift',
  'workflow-install-drift',
  'provider-rate-limited',
  'gate-broken',
  'verify-uncovered',
  'gate-enrichment',
  'budget-window',
  'budget-arc',
  'promotion-decision',
  'arc-verification-failed',
  'signature-storm',
  'signature-wave',
  'gate-enrichment-stale',
  'env-incident',
  'stale-queued',
  'stale-queued-summary',
  'spend-control-notice',
  'scheduling-decision',
  'requeue-warning',
  'arc-superseded-on-main',
  'e2e-tooling-missing',
  'low-disk-space',
  'baseline-broken',
  'dirty-integration',
  'fragmented-repo-layout',
  'recovery-abandoned',
  'mockup-ready',
  'qa-step-list-opt-in',
  'qa-step-list-promote',
  'worktree-hook-trust-request',
  'slicer-transport-outage',
] as const
