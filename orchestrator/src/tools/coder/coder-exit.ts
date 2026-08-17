/**
 * Coder exit classification contract.
 *
 * Shared types and classifier used by:
 *   1. The retryable/terminal classifier slice — adds finer-grained
 *      classification of exit conditions.
 *   2. The run-agent retry-bound slice — calls {@link classifyCoderExit} to
 *      decide whether to do a lightweight single retry (retryable) or hand
 *      off to the full recovery fix-task path (terminal).
 *
 * This module has NO runtime dependencies on the orchestrator's DB, git
 * tooling, or provider clients — it is pure classification logic so both
 * consumers can import it without pulling in side-effect-heavy modules.
 *
 * Exit codes handled by DEDICATED paths in `runAgent` BEFORE the catch-all
 * block (138 context-exhausted, quota-rejected non-zero) are NOT passed to
 * this classifier — callers must guard those first.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Whether a coder exit warrants a single lightweight retry (retryable) or
 * the full recovery fix-task path (terminal).
 *
 * Retryable → the exit was caused by an external/environmental factor unrelated
 * to the coder's output. Re-dispatching on the same worktree is safe; no
 * fix-task is needed.
 *
 * Terminal → the coder ran and produced a result that a bare retry cannot fix.
 * The full recovery path (fix-task spawn, operator alert) applies.
 */
export type CoderExitKind = 'retryable' | 'terminal'

/**
 * Proximate cause of a coder process exit.
 *
 * These values deliberately match the strings the existing `terminationCause`
 * computation in `runAgent` writes to per-run artifact files, so consumer
 * slices can replace the inline computation with {@link coderExitCause} +
 * {@link coderExitDescription} without changing the artifact format.
 */
export type CoderExitCause =
  | 'killed-by-SIGKILL'
  | 'killed-by-SIGTERM'
  | 'timed-out'
  | 'natural-exit-or-unclassified'

/**
 * Full classification result for a coder process exit.
 */
export interface CoderExitClassification {
  /** Retry policy for this exit. */
  kind: CoderExitKind
  /** Proximate cause label. */
  cause: CoderExitCause
  /**
   * Human-readable one-liner written to artifact files and `tasks.error`.
   * Matches the format produced by the existing inline `terminationCause`
   * string in `runAgent` so the artifact format is stable across refactors.
   *
   * Examples:
   *   `'killed-by-SIGKILL'`
   *   `'natural-exit-or-unclassified (exit 1)'`
   */
  description: string
}

/**
 * Observable facts about a coder exit that drive classification.
 */
export interface CoderExitFactors {
  /** Process exit code (non-zero; callers must filter exit 0 before calling). */
  exitCode: number
  /**
   * Number of conversation messages exchanged with the provider before exit.
   * Zero means the coder did not reach the provider — startup, auth, or
   * recursion-guard failure.
   */
  messageCount: number
}

// ---------------------------------------------------------------------------
// Helpers (exported so consumers can use them directly)
// ---------------------------------------------------------------------------

/**
 * Map a raw process exit code to its {@link CoderExitCause} label.
 *
 * Does NOT cover exit 138 (context-budget exhaustion) or quota-rejected paths;
 * those are handled by dedicated blocks in `runAgent` before the catch-all.
 */
export function coderExitCause(exitCode: number): CoderExitCause {
  if (exitCode === 137) return 'killed-by-SIGKILL'
  if (exitCode === 143) return 'killed-by-SIGTERM'
  if (exitCode === 124) return 'timed-out'
  return 'natural-exit-or-unclassified'
}

/**
 * Build the human-readable description string for the given cause and exit
 * code. The format matches what `runAgent` has historically written to
 * per-run artifact files so existing `mars diagnose` tooling is not broken.
 */
export function coderExitDescription(cause: CoderExitCause, exitCode: number): string {
  // Signal-kill and timeout causes are self-describing; appending the raw exit
  // code adds no information (137 IS SIGKILL) and would break existing
  // artifact-format expectations.
  if (cause === 'natural-exit-or-unclassified') {
    return `natural-exit-or-unclassified (exit ${exitCode})`
  }
  return cause
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a non-zero coder process exit as retryable or terminal.
 *
 * **Retryable** exits are caused by external/environmental signals that are
 * not evidence of a code-quality defect. A single re-dispatch on the same
 * worktree — without spawning a recovery fix-task — is the right response:
 *
 *   - **SIGKILL (137)**: OS killed the process (OOM, watchdog ceiling, etc.).
 *   - **SIGTERM (143)**: process was signalled (daemon shutdown, operator stop).
 *   - **Timeout (124)**: per-run wall-clock ceiling reached.
 *
 * **Terminal** exits require the full recovery path (fix-task spawn, operator
 * alert, signature computation):
 *
 *   - Any **natural non-zero exit** (exit 1, 2, …): the coder raised an error.
 *   - **Zero messages + natural exit**: startup / auth / recursion-guard failure.
 *     These tend to be systematic (bad session ID, missing binary) — a bare
 *     retry on the same process configuration hits the same barrier.
 *
 * @param factors - Observable exit facts (exit code + message count).
 * @returns Classification with retry policy, cause label, and description.
 */
export function classifyCoderExit(factors: CoderExitFactors): CoderExitClassification {
  const cause = coderExitCause(factors.exitCode)
  const description = coderExitDescription(cause, factors.exitCode)

  // Environmental kills are retryable regardless of how much work the coder did.
  if (
    cause === 'killed-by-SIGKILL' ||
    cause === 'killed-by-SIGTERM' ||
    cause === 'timed-out'
  ) {
    return { kind: 'retryable', cause, description }
  }

  // Natural exits (exit N, N ≠ 0) are terminal: either the coder ran and
  // failed, or a systematic startup barrier stopped it before reaching the
  // provider.  A bare retry cannot resolve either case.
  return { kind: 'terminal', cause, description }
}
