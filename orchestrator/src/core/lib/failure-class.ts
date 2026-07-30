/**
 * Failure-category classifier.
 *
 * Maps a failure signature (`<failingStep>/<error-class>`) to a broad
 * category so callers can ask "is this a code-level defect a fixer can
 * plausibly resolve?" without hardcoding signature strings at each call site.
 *
 * This module is a pure leaf — it has no imports from other orchestrator
 * modules and must remain so.
 */

export type FailureCategory =
  | 'code'
  | 'infra'
  | 'connectivity'
  | 'orchestration'
  | 'transient'

/**
 * Classify a failure signature into a broad category.
 *
 * Rules (first match wins):
 * - 'connectivity' — API or database unreachable (transient network / env issue)
 * - 'orchestration' — git/worktree state problem, not a code defect
 * - 'infra' — watchdog kill or install timeout (environmental, not code)
 * - 'code' — default; any other signature, including `unclassified`
 */
export function classifyFailure(failureSignature: string): FailureCategory {
  if (
    failureSignature.endsWith('/api-unreachable') ||
    failureSignature.endsWith('/test-pg-connection-refused')
  ) {
    return 'connectivity'
  }

  if (
    failureSignature.endsWith('/rebase-no-in-progress-state') ||
    failureSignature.endsWith('/worktree-missing') ||
    failureSignature.endsWith('/not-fast-forward') ||
    failureSignature.endsWith('/index-lock-contention') ||
    // setup:origin-worktree-missing fires when a recovery (fix) task cannot
    // attach because the origin task's worktree has been removed from disk.
    // This is always an orchestration condition (no amount of code editing
    // fixes a missing worktree); the error class is always 'unclassified'
    // because the OriginWorktreeMissingError message matches no errorClassRule.
    failureSignature.startsWith('setup:origin-worktree-missing')
  ) {
    return 'orchestration'
  }

  if (
    failureSignature.startsWith('phantom-task watchdog:') ||
    failureSignature.endsWith('/install-timeout')
  ) {
    return 'infra'
  }

  return 'code'
}

/**
 * Returns `true` when the failure is NOT a code-level defect — i.e. when a
 * one-shot recovery fixer would not be able to resolve it by editing code.
 */
export function isNonCodeFailure(failureSignature: string): boolean {
  return classifyFailure(failureSignature) !== 'code'
}
