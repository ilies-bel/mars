/**
 * Typed payload contracts for action-queue kinds.
 *
 * ## Why this module exists
 *
 * An action-queue row carries a `payload` blob. The raiser writes keys into it
 * by string name; the kind's recipe in `action-queue-recipes.ts` reads keys out
 * of it by string name. Nothing used to check that those two sets of names
 * agree. When they drifted the row still rendered — with an empty detail panel,
 * so the operator opened an alert and found nothing there.
 *
 * That defect was found three separate times (`failed`, then
 * `daemon-code-drift`, then `awaiting-human` + `gate-enrichment`) before it was
 * closed structurally. This module is the structural close: the payload shape
 * for a kind is declared **once**, and both sides import it.
 *
 *   - `raiseActionQueueItem({ kind: 'awaiting-human', payload })` type-checks
 *     `payload` against {@link AwaitingHumanPayload}.
 *   - the `awaiting-human` recipe receives `ctx.payload` typed as
 *     {@link AwaitingHumanPayload}, so reading a key the raiser does not emit
 *     is a **compile error**, not a blank panel.
 *
 * ## Adding a kind
 *
 * {@link ACTION_QUEUE_PAYLOAD_AUDIT} is total over `ActionQueueKind` via
 * `satisfies`. A new kind therefore does not compile until it is classified
 * there, which is the moment to decide whether it needs a typed contract. That
 * is deliberate: the previous guard was a test someone had to remember, and
 * forgetting it is exactly what let this recur three times.
 *
 * ## Typing the still-`unaudited` kinds
 *
 * The remaining `'unaudited'` kinds are being typed incrementally, one family
 * at a time. {@link UNAUDITED_KIND_FAMILY} assigns each of them to its family
 * — that assignment, not a kind list re-typed in each consumer's prompt, is
 * the source of truth for which kinds a given family slice owns.
 */

import type { ActionQueueKind } from './action-queue-kinds'

// ── Family modules ────────────────────────────────────────────────────────────

export type { OccurrenceTrail } from './payload-contracts/shared'
export type {
  AwaitingHumanSituation,
  LeaseParkPayload,
  LeaseExpiredPayload,
  AwaitingHumanPayload,
  AwaitingHumanContracts,
} from './payload-contracts/awaiting-human'
export { awaitingHumanSituation } from './payload-contracts/awaiting-human'
export type {
  GateEnrichmentPayload,
  GateEnrichmentContracts,
} from './payload-contracts/gate-enrichment'
export type {
  SchedulingDecisionPayload,
  RequeueWarningPayload,
  WorkflowInstallDriftPayload,
  WorkflowDraftPendingPayload,
  FragmentedRepoLayoutPayload,
  CoderQuestionPayload,
  SchedulingContracts,
} from './payload-contracts/scheduling'
export type {
  CancelledBlockerCascadePayload,
  PrerequisiteFailedPayload,
  RecoveryAbandonedPayload,
  ArcSupersededOnMainPayload,
  DoneWithUnmergedCommitsPayload,
  DiagnoseInconclusivePayload,
  LifecycleContracts,
} from './payload-contracts/lifecycle'
export type {
  AwaitingValidationPayload,
  AwaitingValidationPreviewGonePayload,
  BehaviourUnverifiedPayload,
  MockupReadyPayload,
  QaStepListOptInPayload,
  QaStepListPromotePayload,
  ValidationQaContracts,
} from './payload-contracts/validation-qa'
export type {
  DraftProposalPayload,
  ScorerSuggestedPayload,
  PromotionDecisionPayload,
  ToolPromotionPayload,
  ReflectRecommendedPayload,
  ReflectEvidence,
  ProposalContracts,
} from './payload-contracts/proposals'
export type {
  BudgetWindowPayload,
  BudgetArcPayload,
  SpendControlNoticePayload,
  ProviderRateLimitedPayload,
  ApiOutagePayload,
  SpendContracts,
} from './payload-contracts/spend'

import type { AwaitingHumanContracts } from './payload-contracts/awaiting-human'
import type { GateEnrichmentContracts } from './payload-contracts/gate-enrichment'
import type { LifecycleContracts } from './payload-contracts/lifecycle'
import type { ProposalContracts } from './payload-contracts/proposals'
import type { SchedulingContracts } from './payload-contracts/scheduling'
import type { SliceWorkflowContracts } from './payload-contracts/slice-workflow'
import type { SpendContracts } from './payload-contracts/spend'
import type { ValidationQaContracts } from './payload-contracts/validation-qa'

// ── Shared shapes ─────────────────────────────────────────────────────────────

/**
 * Payload for a kind whose raiser/recipe join has not been audited yet.
 *
 * Structurally identical to the old untyped `Record<string, unknown>`, so
 * declaring a kind unaudited is a no-op for its existing raisers. It is a
 * named type rather than an inline `Record` so the remaining work is greppable.
 */
export type UnauditedPayload = Record<string, unknown>

// ── The map ───────────────────────────────────────────────────────────────────

/**
 * Kinds with a hand-written payload contract. Everything else is unaudited.
 * Each family adds exactly one intersection term here.
 */
type AuditedPayloads = AwaitingHumanContracts &
  GateEnrichmentContracts &
  LifecycleContracts &
  ProposalContracts &
  SchedulingContracts &
  SliceWorkflowContracts &
  SpendContracts &
  ValidationQaContracts

/**
 * The payload type for one action-queue kind.
 *
 * Deliberately **non-distributive** (`[K] extends [...]`): it resolves to a
 * contract only when `K` is a single literal kind — i.e. at a raise site that
 * names its kind, and inside a recipe, which are the two ends of the join this
 * module exists to pin together. Code that is generic over all kinds (reading
 * a row back out of the database, dispatching on a runtime kind) gets
 * `UnauditedPayload`, because a payload deserialised from JSON has not been
 * validated against anything and typing it as a union of contracts would be a
 * lie that breaks every generic reader.
 */
export type PayloadFor<K extends ActionQueueKind> =
  [K] extends [keyof AuditedPayloads] ? AuditedPayloads[K] : UnauditedPayload

/**
 * Every action-queue kind, classified by how its payload/recipe join is
 * guarded. Total over `ActionQueueKind` by `satisfies`, so a new kind is a
 * compile error until it is listed here.
 *
 *   - `typed`  — a contract in {@link AuditedPayloads}; a recipe reading a key
 *     the raiser does not emit fails `tsc`.
 *   - `derived-condition` — payload is built by `derived-conditions.ts` and
 *     guarded at runtime by `derived-conditions-payload-contract.test.ts`,
 *     which records the keys each recipe reads through a Proxy.
 *   - `unaudited` — no guard yet. Reduce this list; do not grow it.
 */
export const ACTION_QUEUE_PAYLOAD_AUDIT = {
  'awaiting-human': 'typed',
  'gate-enrichment': 'typed',

  failed: 'derived-condition',
  'steward-repeat': 'derived-condition',
  'daemon-died': 'derived-condition',
  'stale-worktree': 'derived-condition',
  'worktree-ahead': 'derived-condition',
  'subscriber-stalled': 'derived-condition',
  'orphaned-origin': 'derived-condition',
  'phantom-task': 'derived-condition',
  'daemon-code-drift': 'derived-condition',
  'gate-broken': 'derived-condition',
  'signature-storm': 'derived-condition',
  'stale-queued': 'derived-condition',
  'stale-queued-summary': 'derived-condition',
  'baseline-broken': 'derived-condition',
  'e2e-tooling-missing': 'derived-condition',

  'cancelled-blocker-cascade': 'typed',
  'diagnose-inconclusive': 'typed',
  'daemon-killed': 'unaudited',
  'coder-question': 'typed',
  'prerequisite-failed': 'typed',
  'draft-proposal': 'typed',
  'slices-dropped': 'typed',
  'slice-failed': 'typed',
  'hitl-slice-needs-operator': 'typed',
  'awaiting-validation': 'typed',
  'awaiting-validation-preview-gone': 'typed',
  'behaviour-unverified': 'typed',
  'observability-store-oversize': 'unaudited',
  'outbox-lag': 'unaudited',
  'reflect-recommended': 'typed',
  'done-with-unmerged-commits': 'typed',
  'api-outage': 'typed',
  'workflow-install-drift': 'typed',
  'provider-rate-limited': 'typed',
  'verify-uncovered': 'unaudited',
  'workflow-draft-pending': 'typed',
  'budget-window': 'typed',
  'budget-arc': 'typed',
  'scorer-suggested': 'typed',
  'promotion-decision': 'typed',
  'tool-promotion': 'typed',
  'arc-verification-failed': 'unaudited',
  'gate-enrichment-stale': 'unaudited',
  'env-incident': 'unaudited',
  'spend-control-notice': 'typed',
  'scheduling-decision': 'typed',
  'requeue-warning': 'typed',
  'arc-superseded-on-main': 'typed',
  'low-disk-space': 'unaudited',
  'daemon-outage': 'unaudited',
  'dirty-integration': 'unaudited',
  'health-check-alert': 'unaudited',
  'fragmented-repo-layout': 'typed',
  'recovery-abandoned': 'typed',
  'mockup-ready': 'typed',
  'qa-step-list-opt-in': 'typed',
  'qa-step-list-promote': 'typed',
} as const satisfies Record<ActionQueueKind, 'typed' | 'derived-condition' | 'unaudited'>

// ── Kind families ─────────────────────────────────────────────────────────────

/**
 * Kinds still classified `'unaudited'` above. Derived from
 * {@link ACTION_QUEUE_PAYLOAD_AUDIT} rather than hand-listed, so this stays in
 * sync automatically as consumer slices flip entries to `'typed'`.
 */
type UnauditedKind = {
  [K in ActionQueueKind]: (typeof ACTION_QUEUE_PAYLOAD_AUDIT)[K] extends 'unaudited' ? K : never
}[ActionQueueKind]

/**
 * The eight families the remaining unaudited kinds are typed in, one family
 * per consumer slice of PRD `2d84a65a-shrink-the-unaudited-list-in-action-queu`.
 */
export type UnauditedKindFamily =
  | 'slice-workflow'
  | 'validation-qa'
  | 'spend-provider'
  | 'daemon-health'
  | 'task-lifecycle'
  | 'verify-gate'
  | 'proposal-promotion'
  | 'scheduling-workflow-drift'

/**
 * Assigns every still-unaudited kind to the family that will type it.
 *
 * This is the seam the eight consumer slices key off, instead of each
 * hand-copying a kind list from its own prompt into this file. `satisfies
 * Record<UnauditedKind, UnauditedKindFamily>` makes the assignment **total**
 * (every unaudited kind lands in exactly one family — TypeScript rejects a
 * missing key) and **exact** (an excess key, e.g. one a consumer slice forgot
 * to remove after flipping its kind to `'typed'`, is a compile error too).
 *
 * One entry corrects a drift already found at slicing time: the
 * validation/QA consumer slice's prompt names a kind `preview-gone`, which
 * does not exist — the real kind is `awaiting-validation-preview-gone`,
 * listed under `validation-qa` below.
 *
 * `unaudited` classification is temporary scaffolding for this PRD — once
 * every kind above reads `'typed'` or `'derived-condition'`, `UnauditedKind`
 * is `never` and this map (along with `UnauditedKindFamily`) is dead code to
 * delete, which is exactly what "Retire the `unaudited` classification once
 * the list is empty" does.
 */
export const UNAUDITED_KIND_FAMILY = {
  'low-disk-space': 'daemon-health',
  'daemon-outage': 'daemon-health',
  'daemon-killed': 'daemon-health',
  'health-check-alert': 'daemon-health',
  'observability-store-oversize': 'daemon-health',
  'outbox-lag': 'daemon-health',

  'verify-uncovered': 'verify-gate',
  'gate-enrichment-stale': 'verify-gate',
  'arc-verification-failed': 'verify-gate',
  'env-incident': 'verify-gate',
  'dirty-integration': 'verify-gate',
} as const satisfies Record<UnauditedKind, UnauditedKindFamily>
