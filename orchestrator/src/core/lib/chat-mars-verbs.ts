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
  'enable-auto-reflect',
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
