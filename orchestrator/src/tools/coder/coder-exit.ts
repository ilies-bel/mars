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
// Fine-grained disposition classifier (classifyCoderExitDisposition)
// ---------------------------------------------------------------------------

/**
 * Minimal observable shape of a finished coder run used by
 * {@link classifyCoderExitDisposition}.
 *
 * Deliberately mirrors only the fields relevant to classification so this
 * module can remain free of runtime imports from `core/lib/git/claude`.
 */
export interface CoderRunOutcome {
  /** Process exit code. */
  exitCode: number
  /** Combined stderr text from the coder process. */
  stderr: string
  /**
   * Non-null when the provider rejected this run due to rate/spend limits.
   * Mirrors `RunClaudeResult.quotaRejected`.
   */
  quotaRejected: { resetsAt: number } | null
  /**
   * Provider conversation messages.  Length 0 means the coder never reached
   * the provider (startup, auth, or recursion-guard failure).
   */
  conversation: readonly unknown[]
}

/**
 * Fine-grained disposition of a finished coder run.
 *
 * - `success` — exit 0; the coder completed normally.
 * - `retryable-transient` — environmental kill with no prior progress; a
 *   single lightweight re-dispatch on the same worktree is safe.
 * - `terminal-recovery` — the existing fix-task / recovery path applies; the
 *   run must not enter the retry loop.
 * - `terminal-manual` — operator intervention required (reserved for future use).
 * - `terminal-operator-stop` — operator cancelled; no retry, no recovery.
 */
export type CoderExitDisposition =
  | { kind: 'success' }
  | { kind: 'retryable-transient'; reason: string }
  | { kind: 'terminal-recovery'; reason: string }
  | { kind: 'terminal-manual' }
  | { kind: 'terminal-operator-stop' }

/**
 * Pure classifier for a finished coder run.
 *
 * Inspects the exit code, stderr, quota state, conversation length, and
 * whether the workflow abort signal fired, then returns a
 * {@link CoderExitDisposition} that describes what should happen next.
 *
 * Classification rules (in priority order):
 *
 * 1. `aborted` (operator stop) → `terminal-operator-stop`
 * 2. exit 0 → `success`
 * 3. exit 138 + "context budget exhausted" in stderr → `terminal-recovery`
 *    (has its own recovery path; must not enter the retry loop)
 * 4. `quotaRejected !== null` → `terminal-recovery`
 *    (has its own re-queue mechanism; must not enter the retry loop)
 * 5. SIGKILL (137) or SIGTERM (143) with zero messages → `retryable-transient`
 *    (environmental kill before provider contact; safe to retry)
 * 6. SIGKILL or SIGTERM with prior messages → `terminal-recovery`
 *    (coder was making progress when killed; worktree may hold partial work)
 * 7. Any non-zero exit with zero messages → `retryable-transient`
 *    (startup / auth / recursion-guard failure; retry is safe)
 * 8. Natural non-zero exit with messages → `terminal-recovery`
 *    (coder ran and failed; fix-task recovery applies)
 *
 * @param r - Observable facts about the coder run.
 * @param aborted - True when `ctx.signal.aborted` fired before this call.
 */
export function classifyCoderExitDisposition({
  r,
  aborted,
}: {
  r: CoderRunOutcome
  aborted: boolean
}): CoderExitDisposition {
  // Rule 1 — operator cancellation takes priority over all exit-code logic.
  if (aborted) {
    return { kind: 'terminal-operator-stop' }
  }

  // Rule 2 — exit 0 = coder completed normally.
  if (r.exitCode === 0) {
    return { kind: 'success' }
  }

  // Rule 3 — context-budget exhaustion has its own fix-task recovery path and
  // must not be re-dispatched by the retry loop.
  if (r.exitCode === 138 && r.stderr.includes('context budget exhausted')) {
    return { kind: 'terminal-recovery', reason: 'context-budget-exhausted' }
  }

  // Rule 4 — provider rate/spend-limit rejection has its own re-queue
  // mechanism; the retry loop must not interfere.
  if (r.quotaRejected !== null) {
    return { kind: 'terminal-recovery', reason: 'quota-rejected' }
  }

  // Rules 5–8 — non-zero exit (not aborted, not quota, not context-exhausted).
  const messageCount = r.conversation.length

  if (r.exitCode === 137 || r.exitCode === 143) {
    // Environmental signal kill.  Distinguishing factor: whether the coder had
    // already reached the provider before the kill.
    if (messageCount === 0) {
      // Rule 5 — killed before any provider contact; safe to retry.
      return { kind: 'retryable-transient', reason: 'sigkill-no-progress' }
    }
    // Rule 6 — killed while doing real work; worktree may hold partial commits.
    return { kind: 'terminal-recovery', reason: 'killed-with-progress' }
  }

  if (messageCount === 0) {
    // Rule 7 — startup / auth / recursion-guard failure; the coder never
    // reached the provider so the worktree is untouched.  A retry is safe.
    return { kind: 'retryable-transient', reason: 'zero-messages' }
  }

  // Rule 8 — natural non-zero exit after real work; fix-task recovery applies.
  return { kind: 'terminal-recovery', reason: 'natural-exit' }
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
