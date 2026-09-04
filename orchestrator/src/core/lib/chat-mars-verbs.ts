/**
 * Canonical classification of Mars operational verbs as safe (fire immediately)
 * or destructive (require confirmation). Imported by both the alert-card
 * `alertActionStyle` helper and the chat runner so the two paths share one
 * source of truth and cannot drift independently.
 */

/**
 * Mars verbs that are safe to execute without a confirmation prompt.
 * These are read-only or recoverable operations.
 */
export const SAFE_MARS_VERBS: readonly string[] = [
  'list',
  'show',
  'diagnose',
  'restart',
  'unblock',
  'validate',
  'task-add',
  'run-reflect',
  'land-work',
  // Archiving only files a Subthread away, and `unarchive-subthread` puts it
  // back with the transcript intact — recoverable, so it needs no confirmation.
  'archive-subthread',
  'unarchive-subthread',
  // Acknowledging the daemon-died condition just deletes the crash marker file;
  // the daemon has already restarted so this is a non-destructive clear.
  'dismiss-daemon-died',
  // Reverting an auto-commit restores the previous HEAD, so the change is
  // recoverable by construction — no confirmation required.
  'revert-auto-commit',
  // Adding a gate from a proposed spec creates a new verify gate with
  // source='observation' and resolves the verify-uncovered AQ row — the gate
  // can be removed with `mars verify-gate remove`, so this is recoverable.
  'add-gate',
  // Approving a merge-gate step re-queues the task for the merge pipeline.
  // The merge itself is the intended outcome, and it still goes through
  // verify + fast-forward, so this is safe (recoverable via restart/continue).
  'approve-step',
]

/**
 * Mars verbs that require a confirmation step before execution because they
 * mutate or delete state that may be hard to recover.
 */
export const DESTRUCTIVE_MARS_VERBS: readonly string[] = [
  'dismiss',
  'purge',
  'reject',
  'prune-worktree',
  // Aborting a release fails the task — worktree preserved but no merge.
  // Requires confirmation because it ends the operator's work session and
  // routes the task through the failure/recovery path.
  'abort-release',
]

/**
 * Classify a Mars operational verb.
 *
 * @returns `'safe'` when the op is on the safe allowlist,
 *          `'destructive'` when it requires a confirmation step, or
 *          `'unknown'` when the verb is not recognised in either list.
 */
export const classifyMarsVerb = (op: string): 'safe' | 'destructive' | 'unknown' => {
  if (SAFE_MARS_VERBS.includes(op)) return 'safe'
  if (DESTRUCTIVE_MARS_VERBS.includes(op)) return 'destructive'
  return 'unknown'
}

/**
 * Rewrite third-person Mars/orchestrator references into a unified first-person
 * voice so every message the operator reads speaks as one 'I' entity.
 *
 * Transforms (case-insensitive where it makes sense):
 *   'the orchestrator …'  → 'I …'
 *   'Mars reports …'      → 'I am reporting …'
 *   'the worktree was lost' → 'I lost that worktree'
 */
export const renderMarsVoice = (text: string): string => {
  return text
    .replace(/\bthe orchestrator\b/gi, 'I')
    .replace(/\bMars reports\b/gi, 'I am reporting')
    .replace(/\bthe worktree was lost\b/gi, 'I lost that worktree')
}
