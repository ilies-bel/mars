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
    failureSignature.startsWith('setup:origin-worktree-missing') ||
    // code:worktree-missing fires when a resumed run's worktree directory is
    // gone AND its branch no longer exists, so there is nothing to re-attach.
    // Orchestration, not code: no edit to any file can restore a deleted
    // worktree, and routing it to a code fixer would burn the recovery slot.
    failureSignature.startsWith('code:worktree-missing') ||
    // {setup,code}:worktree-rebase-conflict fires when a task's branch cannot
    // be replayed onto the integration tip. The rebase is aborted and the
    // worktree left untouched; resolving it means reconciling two git
    // histories, which is exactly what the vcs-supervisor / operator does.
    // Routing it to a code fixer would burn the single recovery slot on an
    // agent that cannot even see the conflict.
    failureSignature.startsWith('setup:worktree-rebase-conflict') ||
    failureSignature.startsWith('code:worktree-rebase-conflict')
  ) {
    return 'orchestration'
  }

  if (
    failureSignature.startsWith('phantom-task watchdog:') ||
    failureSignature.endsWith('/install-timeout') ||
    // The daemon cannot write <repo>/.git/worktrees/<id>/ — a sandbox or
    // permission condition on the host. A recovery fixer would fail at the
    // very same commit gate, so this must never be classified as 'code'.
    failureSignature.endsWith('/git-metadata-denied') ||
    // The provider CLI could not be executed (spawn ENOENT / exit 127) — the
    // daemon's PATH, not the task's code. A fixer would never even start.
    failureSignature.endsWith('/provider-binary-missing')
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
