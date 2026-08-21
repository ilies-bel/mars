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
 */

import type { ActionQueueKind } from './action-queue-kinds'
import type { VerifyStepSpec } from '../ports/verifier/types'

// ── Shared shapes ─────────────────────────────────────────────────────────────

/**
 * Payload for a kind whose raiser/recipe join has not been audited yet.
 *
 * Structurally identical to the old untyped `Record<string, unknown>`, so
 * declaring a kind unaudited is a no-op for its existing raisers. It is a
 * named type rather than an inline `Record` so the remaining work is greppable.
 */
export type UnauditedPayload = Record<string, unknown>

/**
 * `raiseActionQueueItem` appends each repeat sighting's `occurrence` object to
 * `payload.occurrences`. Raisers never write this key themselves, so it is
 * optional on every contract that can be deduped.
 */
interface OccurrenceTrail {
  occurrences?: readonly Record<string, unknown>[]
}

// ── awaiting-human ────────────────────────────────────────────────────────────

/**
 * `awaiting-human` is raised for three structurally different situations. The
 * recipe used to assume the first one unconditionally, so a row raised for
 * either of the other two rendered a summary that contradicted its own title.
 * Discriminate on `situation` instead of guessing.
 */
export type AwaitingHumanSituation = 'lease-park' | 'lease-expired' | 'escalation'

/** A task parked at a manual step; a human holds the lease and is expected to work. */
export interface LeaseParkPayload extends OccurrenceTrail {
  situation: 'lease-park'
  taskId: string
  leaseOwner: string
  leasedAt: string
  leaseNote: string | null
  /** Manual step the task parked at. Absent on the interactive-park path. */
  stepName?: string
  previewUrl?: string
  logPath?: string
}

/** A lease nobody released; the watchdog noticed it has gone stale. */
export interface LeaseExpiredPayload extends OccurrenceTrail {
  situation: 'lease-expired'
  taskId: string
  leaseOwner: string | null
  leasedAt: string | null
  leaseNote: string | null
  /** Minutes the lease has been held past its expiry. */
  ageMinutes: number
}

/**
 * An agent stopped and escalated to a human rather than bailing silently —
 * e.g. a recovery that found its arc already done. Raised through
 * `mars action-queue raise`, so the payload is agent-authored free-form
 * content; the recipe renders whatever scalar fields it carries rather than
 * looking for fixed key names.
 *
 * `situation` is **required** so a built-in raiser cannot land here by
 * accident: falling into the open branch has to be a deliberate declaration.
 */
interface HumanEscalationPayload {
  situation: 'escalation'
  [key: string]: unknown
}

export type AwaitingHumanPayload =
  | LeaseParkPayload
  | LeaseExpiredPayload
  | HumanEscalationPayload

/**
 * Recover the situation for a row whose payload predates the `situation`
 * discriminator, or that was authored by an agent through the CLI.
 *
 * Structural, not nominal: rows already in the database carry no `situation`
 * key at all, and they must still render the right summary.
 */
export const awaitingHumanSituation = (
  payload: AwaitingHumanPayload,
): AwaitingHumanSituation => {
  const declared = (payload as { situation?: unknown }).situation
  if (declared === 'lease-park' || declared === 'lease-expired' || declared === 'escalation') {
    return declared
  }
  // Legacy rows: infer from the keys the historical raisers emitted.
  if ('ageMinutes' in payload && payload.ageMinutes != null) return 'lease-expired'
  if ('leaseOwner' in payload && payload.leaseOwner) return 'lease-park'
  return 'escalation'
}

// ── gate-enrichment ───────────────────────────────────────────────────────────

/**
 * The operator is asked to approve or retire a candidate verify check.
 *
 * The candidate check lives in `stepSpec` — an **object**, which is why the
 * recipe's old `candidateCheck` string read rendered empty even once the key
 * name was right. Recipes must format it, not stringify it.
 */
export interface GateEnrichmentPayload extends OccurrenceTrail {
  /** Failure signature the candidate check would guard against. */
  signature: string
  /** Static-encodability family, e.g. `'command'`. Null when unclassified. */
  encodableFamily: string | null
  /** Task whose failure produced this candidate. */
  originTaskId: string | null
  /** Verify step that failed, e.g. `verify:build`. */
  failingStep: string
  /** Task that authored the candidate check, if one was spawned. */
  writerTaskId: string | null
  /** The candidate check itself. `null` when no runnable spec was encodable. */
  stepSpec: VerifyStepSpec | null
}

// ── The map ───────────────────────────────────────────────────────────────────

/** Kinds with a hand-written payload contract. Everything else is unaudited. */
interface AuditedPayloads {
  'awaiting-human': AwaitingHumanPayload
  'gate-enrichment': GateEnrichmentPayload
}

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

  'cancelled-blocker-cascade': 'unaudited',
  'diagnose-inconclusive': 'unaudited',
  'daemon-killed': 'unaudited',
  'coder-question': 'unaudited',
  'prerequisite-failed': 'unaudited',
  'draft-proposal': 'unaudited',
  'slices-dropped': 'unaudited',
  'slice-failed': 'unaudited',
  'hitl-slice-needs-operator': 'unaudited',
  'awaiting-validation': 'unaudited',
  'awaiting-validation-preview-gone': 'unaudited',
  'behaviour-unverified': 'unaudited',
  'observability-store-oversize': 'unaudited',
  'outbox-lag': 'unaudited',
  'reflect-recommended': 'unaudited',
  'done-with-unmerged-commits': 'unaudited',
  'api-outage': 'unaudited',
  'workflow-install-drift': 'unaudited',
  'provider-rate-limited': 'unaudited',
  'verify-uncovered': 'unaudited',
  'workflow-draft-pending': 'unaudited',
  'budget-window': 'unaudited',
  'budget-arc': 'unaudited',
  'scorer-suggested': 'unaudited',
  'promotion-decision': 'unaudited',
  'tool-promotion': 'unaudited',
  'arc-verification-failed': 'unaudited',
  'gate-enrichment-stale': 'unaudited',
  'env-incident': 'unaudited',
  'spend-control-notice': 'unaudited',
  'scheduling-decision': 'unaudited',
  'requeue-warning': 'unaudited',
  'arc-superseded-on-main': 'unaudited',
  'low-disk-space': 'unaudited',
  'daemon-outage': 'unaudited',
  'dirty-integration': 'unaudited',
  'health-check-alert': 'unaudited',
  'fragmented-repo-layout': 'unaudited',
  'recovery-abandoned': 'unaudited',
  'mockup-ready': 'unaudited',
  'qa-step-list-opt-in': 'unaudited',
  'qa-step-list-promote': 'unaudited',
} as const satisfies Record<ActionQueueKind, 'typed' | 'derived-condition' | 'unaudited'>
