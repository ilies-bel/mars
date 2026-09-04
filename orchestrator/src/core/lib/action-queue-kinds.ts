/** Action-queue kind vocabulary shared by queue storage and recipe rendering. */
export const ACTION_QUEUE_KINDS = [
  'failed',
  'steward-repeat',
  'cancelled-blocker-cascade',
  'diagnose-inconclusive',
  'daemon-killed',
  'coder-question',
  'daemon-died',
  'stale-worktree',
  'worktree-ahead',
  'prerequisite-failed',
  'draft-proposal',
  'slices-dropped',
  'slice-failed',
  'hitl-slice-needs-operator',
  'awaiting-validation',
  'awaiting-validation-preview-gone',
  'awaiting-human',
  'behaviour-unverified',
  'subscriber-stalled',
  'observability-store-oversize',
  'orphaned-origin',
  'phantom-task',
  'outbox-lag',
  'reflect-recommended',
  'done-with-unmerged-commits',
  'api-outage',
  'daemon-code-drift',
  'workflow-install-drift',
  'provider-rate-limited',
  'gate-broken',
  'verify-uncovered',
  'workflow-draft-pending',
  'gate-enrichment',
  'budget-window',
  'budget-arc',
  'scorer-suggested',
  'promotion-decision',
  'tool-promotion',
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
  'daemon-outage',
  'dirty-integration',
  'health-check-alert',
  'fragmented-repo-layout',
  'recovery-abandoned',
  'mockup-ready',
  'qa-step-list-opt-in',
  'qa-step-list-promote',
  'worktree-hook-trust-request',
] as const

export type ActionQueueKind = (typeof ACTION_QUEUE_KINDS)[number]

export const isActionQueueKind = (s: unknown): s is ActionQueueKind =>
  ACTION_QUEUE_KINDS.includes(s as ActionQueueKind)

// ── Three-class model (ADR-0104) ──────────────────────────────────────────────

/**
 * The three operator-obligation classes of action-queue items.
 *
 * - `notice`   — Mars has an automated move and is taking it; asks nothing of
 *                the operator. Raised to inform, not to request.
 * - `alert`    — Something is wrong and the operator is needed; raised the
 *                moment the last automated move is spent, or immediately when
 *                there never was one.
 * - `decision` — Nothing is wrong, but work cannot proceed until the operator
 *                picks. Raised to gate on a human choice.
 *
 * The set is closed. Every kind must be explicitly classified in
 * {@link KIND_CLASS}; there is no permissive fallback — an unclassified kind
 * is a compile-time error.
 */
export type ActionQueueClass = 'notice' | 'alert' | 'decision'

/**
 * Exhaustive mapping from every action-queue kind to its operator-obligation
 * class. All 61 kinds are listed; adding a new kind to {@link ACTION_QUEUE_KINDS}
 * without a corresponding entry here is a TypeScript error.
 */
export const KIND_CLASS: Record<ActionQueueKind, ActionQueueClass> = {
  // ── notice — Mars has automated move; asks nothing of operator ──────────────
  'subscriber-stalled': 'notice',           // subscription watchdog restarts cursor
  'signature-storm': 'notice',              // circuit breaker active; auto-recovers
  'signature-wave': 'alert',               // N tasks failed for same reason; operator must fix root cause
  'stale-worktree': 'notice',               // worktree pruner handles cleanup
  'phantom-task': 'notice',                 // phantom watchdog removes stale rows
  'requeue-warning': 'notice',              // Mars requeuing; informing
  'arc-superseded-on-main': 'notice',       // Mars superseded arc; informing
  'spend-control-notice': 'notice',         // budget notice; informing
  'reflect-recommended': 'notice',          // recommendation; Mars handles underlying
  'mockup-ready': 'notice',                 // mockup ready; informational, no action required

  // ── alert — something wrong; operator needed ────────────────────────────────
  'failed': 'alert',                        // task failed; recovery exhausted
  'stale-queued': 'alert',                  // tasks stuck in queue; dispatch issue
  'stale-queued-summary': 'alert',          // batch summary of stale-queued
  'gate-broken': 'alert',                   // CI/verify gate broken
  'daemon-died': 'alert',                   // daemon crashed; no auto-respawn succeeded
  'daemon-code-drift': 'alert',             // template drift; operator must update
  'baseline-broken': 'alert',               // main branch broken
  'worktree-ahead': 'alert',                // commits stranded in worktree
  'orphaned-origin': 'alert',               // origin task orphaned
  'steward-repeat': 'alert',                // steward stuck in repeat loop
  'e2e-tooling-missing': 'alert',           // tooling not installed
  'diagnose-inconclusive': 'alert',         // investigation gave no answer
  'daemon-killed': 'alert',                 // daemon killed unexpectedly
  'prerequisite-failed': 'alert',           // prerequisite check failed
  'slice-failed': 'alert',                  // a PRD slice failed
  'awaiting-validation-preview-gone': 'alert', // preview URL gone; cannot validate
  'behaviour-unverified': 'alert',          // behaviour check failed
  'api-outage': 'alert',                    // external API down
  'provider-rate-limited': 'alert',         // provider rate limiting
  'env-incident': 'alert',                  // env configuration problem
  'low-disk-space': 'alert',               // disk space critical
  'daemon-outage': 'alert',                // daemon outage detected
  'dirty-integration': 'alert',            // integration branch dirty
  'health-check-alert': 'alert',           // health check failure
  'fragmented-repo-layout': 'alert',       // repo layout fragmented
  'recovery-abandoned': 'alert',           // recovery gave up; no automated moves left
  'arc-verification-failed': 'alert',      // arc-level verification failed
  'workflow-install-drift': 'alert',       // workflow templates drifted
  'done-with-unmerged-commits': 'alert',   // task done but commits not merged
  'outbox-lag': 'alert',                   // outbox processing backed up
  'cancelled-blocker-cascade': 'alert',    // Mars cancelled dependents; state needs operator attention
  'slices-dropped': 'alert',               // Mars dropped slices; operator must intervene
  'observability-store-oversize': 'alert', // store oversize; operator must act
  'coder-question': 'alert',               // coder has a question; operator is on the hook
  'budget-window': 'alert',               // budget window exceeded; operator must act
  'budget-arc': 'alert',                  // arc budget issue; operator must act

  // ── decision — nothing wrong; operator must pick to proceed ────────────────
  'draft-proposal': 'decision',            // proposal awaiting approval
  'hitl-slice-needs-operator': 'decision', // HITL slice step needs operator
  'awaiting-validation': 'decision',       // waiting for operator validation
  'awaiting-human': 'decision',            // manual step; operator must act
  'workflow-draft-pending': 'decision',    // workflow draft needs operator review
  'gate-enrichment': 'decision',           // gate enrichment needed
  'scorer-suggested': 'decision',          // scorer suggested; operator decides
  'promotion-decision': 'decision',        // operator must decide on promotion
  'tool-promotion': 'decision',           // operator must decide on tool promotion
  'qa-step-list-opt-in': 'decision',      // operator must opt in to QA step list
  'qa-step-list-promote': 'decision',     // operator must promote QA step list
  'scheduling-decision': 'decision',       // operator must choose a scheduling option
  'gate-enrichment-stale': 'decision',    // enrichment request timed out; operator picks next step
  'verify-uncovered': 'decision',         // task has no verify command; operator must decide
  'worktree-hook-trust-request': 'decision', // mars.json setup hooks await trust grant from operator
}

/**
 * Map a kind to its operator-obligation class.
 * Every kind is explicitly classified in {@link KIND_CLASS}; calling this
 * with an unknown kind is a TypeScript error.
 */
export const classifyKind = (kind: ActionQueueKind): ActionQueueClass => KIND_CLASS[kind]

/**
 * Structural subset: kinds whose items are derived on every read from live
 * system state — no stored row, no raiser. A derived item vanishes the moment
 * its predicate goes false.
 *
 * This is a *structural* property, independent of operator-obligation class.
 * Its primary use is timestamp selection in rendering: a derived item's
 * `lastSeenAt` reflects the query time, not the event time, so display code
 * should use `raisedAt` (the underlying evidence timestamp) instead.
 */
export const DERIVED_KINDS: ReadonlySet<ActionQueueKind> = new Set<ActionQueueKind>([
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
])
