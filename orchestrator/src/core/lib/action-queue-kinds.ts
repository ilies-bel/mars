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
] as const

export type ActionQueueKind = (typeof ACTION_QUEUE_KINDS)[number]

export const isActionQueueKind = (s: unknown): s is ActionQueueKind =>
  ACTION_QUEUE_KINDS.includes(s as ActionQueueKind)

// ── Three-class model ─────────────────────────────────────────────────────────

/**
 * The three structural classes of action-queue items (introduced alongside
 * the two-class model in ADR-0094).
 *
 * - `condition` — derived on read from live state; its predicate going false
 *   makes it vanish. Dismissal is structurally unavailable.
 * - `decision`  — row-backed; closed atomically with the resolving mutation;
 *   has explicit verbs (accept, reject, approve, …).
 * - `notice`    — row-backed; closed by the user saying "I have read this."
 *   Dismissal is terminal and durable: once dismissed, the raiser must not
 *   re-create it (checked via the `notice_dismissals` table).
 */
export type ActionQueueClass = 'condition' | 'decision' | 'notice'

/**
 * Kinds whose items are pure derived conditions — computed on every read
 * from live system state, never stored. A condition item vanishes the moment
 * its predicate goes false.
 */
export const CONDITION_KINDS: ReadonlySet<ActionQueueKind> = new Set<ActionQueueKind>([
  'failed',
  'stale-queued',
  'stale-queued-summary',
  'gate-broken',
  'subscriber-stalled',
  'signature-storm',
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

/**
 * Kinds whose items are informational events the user acknowledges with
 * "I have read this." Dismissal is terminal and durable. The raiser must
 * check for a prior dismissal record (via `isNoticeDismissed`) before
 * re-raising.
 */
export const NOTICE_KINDS: ReadonlySet<ActionQueueKind> = new Set<ActionQueueKind>([
  'spend-control-notice',
  'scheduling-decision',
  'requeue-warning',
  'arc-superseded-on-main',
  'mockup-ready',
])

/**
 * Map a kind to its structural class.
 * Unmapped kinds default to `decision` — backwards-compatible for any kind
 * not yet explicitly classified.
 */
export const classifyKind = (kind: ActionQueueKind): ActionQueueClass => {
  if (CONDITION_KINDS.has(kind)) return 'condition'
  if (NOTICE_KINDS.has(kind)) return 'notice'
  return 'decision'
}
