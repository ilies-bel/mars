/**
 * Pure relevance scorer for closed Subjects.
 *
 * Accepts observable facts about a closed Subject and returns a normalised
 * 0–1 score representing residual utility. Higher scores mean the Subject
 * is more likely to still be worth keeping in context; lower scores indicate
 * it can be evicted.
 *
 * No I/O, no side effects — import and call.
 */

export interface SubjectRelevanceInput {
  /** Epoch-ms when the Subject was closed. */
  closedAtMs: number
  /** Epoch-ms representing "now" (the point in time we are scoring from). */
  nowMs: number
  /** Number of tasks the Subject queued during its lifetime. */
  taskCount: number
  /** Whether the Subject was opened from an alert and resolved it. */
  resolvedAlert: boolean
  /** Total tokens produced by provider calls inside the Subject. */
  producedTokens: number
}

/**
 * Weights applied to each scoring signal.
 *
 * All four signals combined can exceed 1.0 before the final clamp — the
 * clamp is intentional: a Subject that scores on every dimension is still
 * exactly 1.0, not above it.
 */
export const RELEVANCE_WEIGHTS = {
  /** Age-decay base weight — the primary signal. */
  age: 1.0,
  /** Bonus for having queued at least some tasks. */
  taskCount: 0.3,
  /** Bonus for having resolved an alert. */
  alert: 0.2,
  /** Bonus for substantial token production (diminishing returns). */
  tokens: 0.1,
} as const

/**
 * Score a closed Subject's residual relevance.
 *
 * Algorithm:
 *   ageDays  = (nowMs − closedAtMs) / 86_400_000
 *   ageDecay = exp(−ageDays / 14)          // half-life ≈ 9.7 days
 *   score    = ageDecay × 1.0
 *            + min(taskCount / 5, 1) × 0.3
 *            + (resolvedAlert ? 0.2 : 0)
 *            + min(producedTokens / 8000, 1) × 0.1
 *   return clamp(score, 0, 1)
 *
 * @returns A value in [0, 1].
 */
export function scoreSubjectRelevance(input: SubjectRelevanceInput): number {
  const ageDays = (input.nowMs - input.closedAtMs) / 86_400_000
  const ageDecay = Math.exp(-ageDays / 14)

  const sum =
    ageDecay * RELEVANCE_WEIGHTS.age +
    Math.min(input.taskCount / 5, 1) * RELEVANCE_WEIGHTS.taskCount +
    (input.resolvedAlert ? RELEVANCE_WEIGHTS.alert : 0) +
    Math.min(input.producedTokens / 8_000, 1) * RELEVANCE_WEIGHTS.tokens

  return Math.max(0, Math.min(1, sum))
}
