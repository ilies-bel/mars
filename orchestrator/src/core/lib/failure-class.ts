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
    // verify:worktree-missing fires when verify — the first step to actually
    // execute on a checkpoint-resume — finds the worktree directory gone AND
    // its branch deleted (typically a recovery that merged and cleaned up the
    // shared worktree). Orchestration, not code: there is no tree left to
    // verify, so a code fixer has nothing to edit.
    failureSignature.startsWith('verify:worktree-missing') ||
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

/**
 * Returns `true` when the broken precondition IS the worktree — the directory
 * is gone (and, for the resume signatures, its branch with it).
 *
 * This is the "does re-queueing alone help?" question, and it is deliberately
 * NARROWER than {@link classifyFailure}`() === 'orchestration'`. A re-queue
 * resumes the durable run, so a `setup` step already recorded as `'completed'`
 * short-circuits and no worktree is ever rebuilt. For these signatures the
 * re-queue must therefore be paired with a restart-from-setup reset
 * (`resetForSetupReplay`); for every other environmental signature — provider
 * quota, API transient, watchdog kill — the worktree is intact and MUST be
 * preserved, because it holds the coder's committed work.
 *
 * Excluded on purpose: `verify:worktree-hygiene/branch-drift` and
 * `/stale-rebase-state`. Those worktrees still exist on disk; discarding them
 * is a heavier remedy than the condition warrants and would drop uncommitted
 * state the operator may want to inspect.
 */
export function requiresWorktreeRebuild(failureSignature: string): boolean {
  return (
    // `verify:worktree-missing` / `code:worktree-missing` — the resume
    // preflight found directory AND branch both absent (the error class is
    // `unclassified` because ResumeWorktreeUnrecoverable's message matches no
    // errorClassRule, so the step half is what identifies these).
    failureSignature.startsWith('verify:worktree-missing') ||
    failureSignature.startsWith('code:worktree-missing') ||
    // `<step>/worktree-missing` — the errorClass rule for "worktree path … no
    // longer exists", e.g. `verify:worktree-hygiene/worktree-missing`.
    failureSignature.endsWith('/worktree-missing')
  )
}
