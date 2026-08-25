/**
 * Payload contracts for the `spend-provider` action-queue family:
 * budget-window, budget-arc, spend-control-notice, provider-rate-limited,
 * and api-outage.
 *
 * ## Raiser / recipe joins
 *
 * - `budget-window`: raised by the spend meter when rolling token spend
 *   crosses the warning threshold. Recipe reads `spentTokens`,
 *   `thresholdTokens`, and `windowStart`.
 *
 * - `budget-arc`: raised when a live arc's cumulative spend crosses the
 *   configured per-arc ceiling. Recipe reads `arcId`, `spentTokens`, and
 *   `ceilingTokens`.
 *
 * - `spend-control-notice`: raised by `outbox/spend-control-notifier.ts`
 *   when dispatch transitions between paused and allowed. Recipe reads
 *   `direction`, `reason`, and `rampBackFactor`.
 *
 * - `provider-rate-limited`: raised in `daemon/server.ts` when the API
 *   returns a quota rejection. Recipe reads `resetsAtIso`.
 *
 * - `api-outage`: raised in `outbox/subscribers/action-queue-raisers.ts`
 *   when the circuit breaker trips. Recipe reads `openedAt` and
 *   `occurrences` (from OccurrenceTrail).
 */

import type { OccurrenceTrail } from './shared'

// ── Shared base ───────────────────────────────────────────────────────────────

/**
 * Both budget kinds report a token-spend figure; this base captures the
 * shared field so the two interfaces stay in sync if the naming ever changes.
 */
interface BudgetSpendBase {
  /** Weighted tokens consumed in the measured period or arc. */
  spentTokens: number | null
}

// ── budget-window ─────────────────────────────────────────────────────────────

/**
 * Raised when rolling token spend in the configured time window crosses the
 * warning threshold (>= 70 %). Dispatch is NOT paused — this is an
 * informational alert.
 */
export interface BudgetWindowPayload extends BudgetSpendBase {
  /** Configured warning ceiling in tokens. */
  thresholdTokens: number | null
  /** ISO timestamp at which the measurement window began. */
  windowStart: string | null
}

// ── budget-arc ────────────────────────────────────────────────────────────────

/**
 * Raised when a live arc's cumulative token spend crosses the per-arc
 * ceiling. Dispatch is NOT paused — this is an informational alert.
 */
export interface BudgetArcPayload extends BudgetSpendBase {
  /** Arc id (origin task id for the arc). */
  arcId: string | null
  /** Configured per-arc spending ceiling in tokens. */
  ceilingTokens: number | null
}

// ── spend-control-notice ──────────────────────────────────────────────────────

/**
 * Raised by `outbox/spend-control-notifier.ts` when dispatch transitions
 * between `paused` and `allowed` due to the spend controller.
 *
 * Fields other than `direction` are optional so that notice-dismissal tests
 * can raise a minimal `{ direction, noticeKey }` payload without satisfying
 * every raiser field. The real raiser always provides all fields.
 */
export interface SpendControlNoticePayload {
  /** Whether this notice signals a pause or a resume. */
  direction: 'paused' | 'resumed'
  /** Human-readable reason text from the spend-control decision. */
  reason?: string | null
  /** Ramp-back factor applied on resume (1 = full capacity). */
  rampBackFactor?: number | null
  /** Whether recovery task spawning was suppressed during the pause. */
  suppressRecovery?: boolean | null
  /**
   * Notice key for the dismissal infrastructure. When present, matches the
   * action-queue kind (`'spend-control-notice'`). Populated by callers that
   * use the notice dismissal system; absent in the spend-control notifier
   * itself (which uses the kind directly).
   */
  noticeKey?: string
}

// ── provider-rate-limited ─────────────────────────────────────────────────────

/**
 * Raised in `daemon/server.ts` when the Claude API returns a rate or
 * spend-limit rejection. Dispatch is paused until `resetsAtIso`.
 */
export interface ProviderRateLimitedPayload extends OccurrenceTrail {
  /**
   * ISO timestamp when dispatch will auto-resume (computed as the API's
   * `resetsAt` epoch-seconds plus a 60-second jitter cushion). `null` when
   * the reset time was not supplied by the API — a 30-minute fallback is
   * used in that case.
   */
  resetsAtIso: string | null
}

// ── api-outage ────────────────────────────────────────────────────────────────

/**
 * Raised in `outbox/subscribers/action-queue-raisers.ts` when the API
 * circuit breaker trips. One row per breaker episode; each affected task's
 * failure is appended to `occurrences` rather than creating a sibling row.
 */
export interface ApiOutagePayload extends OccurrenceTrail {
  /** Epoch-millisecond timestamp when the circuit breaker opened. */
  openedAt: number
  /** Human-readable reason text from the breaker (null if not recorded). */
  reason: string | null
}

// ── Contracts map ─────────────────────────────────────────────────────────────

/** Kind-to-payload map for intersection into `AuditedPayloads`. */
export interface SpendContracts {
  'budget-window': BudgetWindowPayload
  'budget-arc': BudgetArcPayload
  'spend-control-notice': SpendControlNoticePayload
  'provider-rate-limited': ProviderRateLimitedPayload
  'api-outage': ApiOutagePayload
}

// ── Representative payloads ───────────────────────────────────────────────────

/** Representative fixture for the payload-contract test. */
export const REPRESENTATIVE_PAYLOADS: Record<
  | 'budget-window'
  | 'budget-arc'
  | 'spend-control-notice'
  | 'provider-rate-limited'
  | 'api-outage',
  Record<string, unknown>
> = {
  'budget-window': {
    spentTokens: 420_000,
    thresholdTokens: 500_000,
    windowStart: '2026-08-25T00:00:00.000Z',
  },
  'budget-arc': {
    arcId: 'mars-abc123',
    spentTokens: 810_000,
    ceilingTokens: 750_000,
  },
  'spend-control-notice': {
    direction: 'paused',
    reason: 'spend-rate exceeded 80% threshold',
    rampBackFactor: 0.5,
    suppressRecovery: true,
  },
  'provider-rate-limited': {
    resetsAtIso: '2026-08-25T10:00:00.000Z',
  },
  'api-outage': {
    openedAt: 1_724_573_600_000,
    reason: 'max consecutive failures exceeded',
    // Include one occurrence so humanDetail.occurrences is non-empty and the
    // substantive-fields assertion in the contract test passes.
    occurrences: [{ taskId: 'mars-test-1', failureSignature: 'verify:build' }],
  },
}
