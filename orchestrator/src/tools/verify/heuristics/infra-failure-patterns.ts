/**
 * Built-in verify heuristic: infrastructure-failure patterns.
 *
 * Extracted verbatim from `core/lib/git/verify.ts` (TARGET §4.5). Answers one
 * question — "is this failing output the environment, or the code?" — and
 * answers it ADVISORY-only: the runner records the step unchanged, and the
 * `review` primitive shell reads the `infra` verdict to decide whether to
 * re-run the whole suite once. That is exactly the division of labour the code
 * already had; the seam is new, the behaviour is not.
 *
 * Background: when multiple tasks run their verify steps in parallel, each
 * gradle/Spring build spins up its own embedded-PG instance. One build's
 * Gradle daemon teardown (or an OS-level OOM eviction) can shut down another
 * build's database mid-suite, producing the "the database system is shutting
 * down" FATAL that cascades into dozens of phantom integration-test failures
 * and empty Spring-context init errors. Those are infrastructure flakes, not
 * code regressions.
 *
 * A per-step timeout counts as infrastructure too: a hung test suite is an
 * environment problem (deadlock, OOM, PGLite fixture serialisation), not a
 * code regression. The first timeout triggers a single retry; a second is
 * final.
 *
 * Genuine assertion failures (JUnit `AssertionFailedError`, TypeScript type
 * errors, `NullPointerException`, …) do NOT match these patterns and are never
 * silently swallowed. Empty output is deliberately NOT infra: an empty failure
 * is ambiguous — it could be a Spring context init error caused by an infra
 * race, but equally a genuine process crash. If that case proves prevalent it
 * gets its own heuristic rather than a widening of this one.
 */
import { VERIFY_TIMEOUT_MARKER } from '../../../core/ports/verifier/verify-helpers'
import type { VerifyHeuristic, VerifyStepOutcome, VerifyVerdict } from './types'

/**
 * Patterns in verify-step output that indicate an infrastructure failure
 * (embedded-PostgreSQL shutdown, Spring context initialisation error,
 * connection-refused to an embedded port, or a per-step wall-clock timeout)
 * rather than a genuine code-level assertion failure.
 */
export const VERIFY_INFRA_FAILURE_PATTERNS: readonly RegExp[] = [
  /FATAL: the database system is shutting down/i,
  /the database system is shutting down/i,
  /org\.springframework\.dao\.DataAccessResourceFailureException/,
  /org\.springframework\.context\.ApplicationContextException/,
  /Connection refused.*\d+/i,
  // Per-step timeout: the VERIFY_TIMEOUT_MARKER prefix is always the first
  // non-blank line when the timeout fires.
  new RegExp(`^${VERIFY_TIMEOUT_MARKER} `),
]

/**
 * Returns `true` when the given verify-step output matches at least one
 * infrastructure-failure pattern rather than a genuine assertion failure.
 *
 * Empty or whitespace-only output returns `false` — treat it as ambiguous and
 * fall through to standard failure handling.
 */
export const isInfraFailureOutput = (output: string): boolean => {
  if (!output || output.trim() === '') return false
  return VERIFY_INFRA_FAILURE_PATTERNS.some((p) => p.test(output))
}

export const infraFailurePatternsHeuristic: VerifyHeuristic = {
  name: 'infra-failure-patterns',
  classify(result: VerifyStepOutcome): VerifyVerdict | undefined {
    if (result.passed) return undefined
    return isInfraFailureOutput(result.output) ? { kind: 'infra' } : undefined
  },
}
