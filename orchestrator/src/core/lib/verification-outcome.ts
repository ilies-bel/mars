/**
 * Shared tri-state verification outcome (ADR-0070).
 *
 * Every checker in Mars that probes a condition and reports back — the
 * health-check registry (`core/health/registry.ts`) and behaviour-verify
 * (`workflows/primitives/behaviour-verify.ts`) today, any checker written
 * after this one tomorrow — resolves its probe to exactly one of three
 * states:
 *
 *   'pass'        — the check succeeded / the criterion was positively
 *                   verified.
 *   'fail'        — positive evidence of contradiction: the check reached
 *                   the surface it needed and observed the condition unmet.
 *   'cant-verify' — everything else. A missing prerequisite, an
 *                   unreachable surface, ambiguity, or an infrastructure
 *                   error is ALWAYS 'cant-verify', never 'fail'.
 *
 * ADR-0070 ("Behaviour verification distinguishes FAIL from CAN'T-VERIFY;
 * only FAIL blocks") states the boundary in one line: FAIL requires
 * positive evidence of contradiction on a reached live surface; absence,
 * ambiguity, or infrastructure error is always CAN'T-VERIFY. That rule is
 * general — it is not specific to behaviour-verify — so it is captured
 * once, here, rather than re-derived independently by every checker.
 *
 * This module is the ONE place the three-way split is named. A checker's
 * own status/decision field is free to use domain-appropriate words (the
 * health registry's 'ok' | 'finding' | 'skipped', behaviour-verify's
 * 'pass' | 'fail' | 'unverifiable'), but every such field must be a
 * relabelling of exactly these three states. {@link verificationOutcomeLabels}
 * makes that relabelling exhaustive and type-checked, so a checker can
 * never silently grow a fourth state, and a reader can always recover the
 * shared meaning behind a checker's local vocabulary.
 *
 * Only the outcome is shared. What happens NEXT — `CheckDef.route`
 * ('fix' | 'notice' | 'alert') and ADR-0070's own consequences (spawn one
 * recovery Chore / raise an action-queue row and let merge proceed) — are
 * deliberately separate, per-checker policies over this same outcome and
 * are out of scope here.
 */

/** The shared tri-state outcome. See the module doc for the meaning of each state. */
export type VerificationOutcome = 'pass' | 'fail' | 'cant-verify'

/**
 * Declare a checker-local status/decision vocabulary as a relabelling of
 * {@link VerificationOutcome}.
 *
 * `labels` must supply exactly one label per canonical state — TypeScript
 * rejects a map that is missing a state or invents an extra one — so the
 * resulting field type is provably isomorphic to the shared contract
 * instead of an independently-invented union that happens to also have
 * three members.
 *
 * Usage:
 * ```ts
 * const STATUS = verificationOutcomeLabels({
 *   pass: 'ok',
 *   fail: 'finding',
 *   'cant-verify': 'skipped',
 * })
 * type CheckStatus = (typeof STATUS)[VerificationOutcome] // 'ok' | 'finding' | 'skipped'
 * ```
 */
export const verificationOutcomeLabels = <const L extends Record<VerificationOutcome, string>>(
  labels: L,
): L => labels
