/**
 * Output markers the verify runner writes into a step's recorded output.
 *
 * A LEAF module on purpose. These strings are part of the runner's *output
 * contract*: the failure classifier (`core/lib/failure-signature.ts`) and the
 * verify heuristics (`tools/verify/heuristics/`) both match against them.
 * Keeping them here means a heuristic can recognise a runner-emitted marker
 * without importing the runner — which would close the loop
 * runner → heuristic registry → heuristic → runner into an import cycle.
 */

/**
 * Prepended by `runVerifyStep` when the per-step wall-clock timeout fires and
 * the subprocess is killed. Consumed by `computeFailureSignature` to produce
 * `verify:timeout/<step-name>` rather than an `unclassified` verdict, and
 * matched by the `infra-failure-patterns` heuristic so the first timeout gets
 * an automatic infra retry (a second timeout is final).
 */
export const VERIFY_TIMEOUT_MARKER = 'verify child timed out after'
