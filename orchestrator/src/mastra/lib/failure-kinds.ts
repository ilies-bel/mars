/**
 * Failure-kind registry — one record per known `<failingStep>/<error-class>`
 * signature.
 *
 * Each record bundles the plain-language copy the action queue renders for an
 * operator: a short warm title for the list row, a one-sentence verbose reason
 * for the detail pane, and a recovery action menu.
 *
 * This module is pure data with no runtime side-effects. It has no consumers
 * yet; downstream slices will wire it into the action queue view builder and
 * the failure-reason lookup path.
 *
 * Adding a new entry:
 *   1. Add the error-class rule to `failure-signature.ts` (if the class is new).
 *   2. Add a `FailureKind` entry to `FAILURE_KINDS` below.
 *   3. The `lookupFailureKind` function picks it up automatically.
 */

import type { ActionDescriptor } from './error-kinds'
import { firstNonBlankLine } from './failure-signature'
import { DAEMON_KILLED_SIGNATURE } from './retry-budget'

export interface FailureKind {
  /** The full `<failingStep>/<error-class>` signature this record covers. */
  signature: string
  /**
   * Short plain-English title shown on the action queue list row.
   * Operator-facing; must be a complete sentence fragment a non-engineer
   * can parse without context.
   */
  warmTitle: string
  /**
   * One-sentence calm explanation shown in the detail pane.
   * Names the step and the root cause without jargon.
   */
  verboseReason: string
  /** Ordered recovery action menu rendered by the UI. */
  actions: ActionDescriptor[]
}

/**
 * Default action menu: restart from scratch, or drop permanently.
 * Mirrors the spirit of COMMON_ACTIONS in failure-reasons/built-in.ts using
 * the ActionDescriptor shape (which carries an `op` verb, not a CLI hint).
 */
const DEFAULT_ACTIONS: ActionDescriptor[] = [
  { id: 'restart', label: 'Restart from scratch', op: 'restart' },
  { id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true },
]

/**
 * Recovery menu for daemon-killed tasks: batch-restart all affected tasks.
 * Mirrors the `restart-all-daemon-killed` convention from error-kinds.ts.
 */
const DAEMON_KILLED_ACTIONS: ActionDescriptor[] = [
  {
    id: 'restart-all',
    label: 'Restart all daemon-killed',
    op: 'restart-all-daemon-killed',
  },
]

/**
 * The registry. Every named failure cause the action queue can present as a
 * warm, human-readable failure card is listed here.
 *
 * Ordering is informational only; lookups use `Array.find` on `signature`.
 */
export const FAILURE_KINDS: readonly FailureKind[] = Object.freeze([
  // ── setup:install ────────────────────────────────────────────────────────────
  {
    signature: 'setup:install/install-frozen-lockfile',
    warmTitle: 'The coding environment could not be set up',
    verboseReason:
      'The setup step could not install dependencies because the lockfile no longer matches the manifest.',
    actions: DEFAULT_ACTIONS,
  },
  {
    signature: 'setup:install/install-timeout',
    warmTitle: 'The coding environment could not be set up',
    verboseReason:
      'The setup step timed out (SIGKILL / exit 137) while installing dependencies.',
    actions: DEFAULT_ACTIONS,
  },
  {
    signature: 'setup:install/install-missing-peer',
    warmTitle: 'The coding environment could not be set up',
    verboseReason:
      'The setup step could not install dependencies because a required peer dependency is missing from the manifest.',
    actions: DEFAULT_ACTIONS,
  },

  // ── code:no-edits-made ───────────────────────────────────────────────────────
  {
    signature: 'code:no-edits-made/unclassified',
    warmTitle: 'The coder stopped before starting to write',
    verboseReason:
      'The code step completed without producing any file changes; the coder may have misunderstood the task or encountered an unrecognised error.',
    actions: DEFAULT_ACTIONS,
  },

  // ── verify:has-diff ──────────────────────────────────────────────────────────
  {
    signature: 'verify:has-diff/no-commits-ahead',
    warmTitle: 'The coder stopped mid-task',
    verboseReason:
      'The verify step found no commits ahead of the integration branch; the coder made changes but did not commit them.',
    actions: DEFAULT_ACTIONS,
  },

  // ── code:timeout ─────────────────────────────────────────────────────────────
  // One entry covers the SIGKILL / exit-137 class: the coding worker was
  // terminated by the wall-clock watchdog.
  {
    signature: 'code:timeout/install-timeout',
    warmTitle: 'The coder took too long',
    verboseReason:
      'The code step was killed (SIGKILL / exit 137) because it exceeded its wall-clock time budget.',
    actions: DEFAULT_ACTIONS,
  },

  // ── code:over-budget ─────────────────────────────────────────────────────────
  {
    signature: 'code:over-budget/unclassified',
    warmTitle: 'The task was too large for the coder to finish in one run',
    verboseReason:
      'The code step exhausted its token budget before completing the task; consider splitting the work into smaller slices.',
    actions: DEFAULT_ACTIONS,
  },

  // ── verify:typecheck ─────────────────────────────────────────────────────────
  // One entry per registered typecheck-* error-class slug in failure-signature.ts,
  // plus a generic unclassified fallback.
  {
    signature: 'verify:typecheck/typecheck-property-not-exist',
    warmTitle: 'The changes did not pass type-checking',
    verboseReason:
      'The verify step failed because one or more properties accessed in the code do not exist on the declared type (TS2339 / TS2353).',
    actions: DEFAULT_ACTIONS,
  },
  {
    signature: 'verify:typecheck/typecheck-cannot-find-name',
    warmTitle: 'The changes did not pass type-checking',
    verboseReason:
      'The verify step failed because the code references a name that is not in scope (TS2304).',
    actions: DEFAULT_ACTIONS,
  },
  {
    signature: 'verify:typecheck/typecheck-cannot-find-module',
    warmTitle: 'The changes did not pass type-checking',
    verboseReason:
      'The verify step failed because an import could not be resolved to a known module (TS2307).',
    actions: DEFAULT_ACTIONS,
  },
  {
    signature: 'verify:typecheck/typecheck-type-mismatch',
    warmTitle: 'The changes did not pass type-checking',
    verboseReason:
      'The verify step failed because a value was assigned to an incompatible type (TS2322).',
    actions: DEFAULT_ACTIONS,
  },
  {
    signature: 'verify:typecheck/typecheck-arg-type-mismatch',
    warmTitle: 'The changes did not pass type-checking',
    verboseReason:
      'The verify step failed because a function argument has a type incompatible with the declared parameter (TS2345).',
    actions: DEFAULT_ACTIONS,
  },
  {
    signature: 'verify:typecheck/typecheck-excess-property',
    warmTitle: 'The changes did not pass type-checking',
    verboseReason:
      'The verify step failed because an object literal contains a property that does not exist in the target type (TS2353 excess-property check).',
    actions: DEFAULT_ACTIONS,
  },
  {
    signature: 'verify:typecheck/typecheck-missing-export',
    warmTitle: 'The changes did not pass type-checking',
    verboseReason:
      'The verify step failed because the code imports a named export that does not exist in the target module (TS2694).',
    actions: DEFAULT_ACTIONS,
  },
  {
    signature: 'verify:typecheck/unclassified',
    warmTitle: 'The changes did not pass type-checking',
    verboseReason:
      'The verify step failed during type-checking with an error pattern that has not yet been classified.',
    actions: DEFAULT_ACTIONS,
  },

  // ── merge:vcs-supervisor-aborted ─────────────────────────────────────────────
  {
    signature: 'merge:vcs-supervisor-aborted/merge-conflict-unresolved',
    warmTitle: 'The changes clashed with main and were too hard to merge',
    verboseReason:
      'The merge step was aborted by the VCS supervisor because a conflict between the task branch and the integration branch could not be automatically resolved.',
    actions: DEFAULT_ACTIONS,
  },
  {
    signature: 'merge:vcs-supervisor-aborted/unclassified',
    warmTitle: 'The changes clashed with main and were too hard to merge',
    verboseReason:
      'The merge step was aborted by the VCS supervisor with an unrecognised error; inspect the transcript for details.',
    actions: DEFAULT_ACTIONS,
  },

  // ── daemon-killed ─────────────────────────────────────────────────────────────
  // Uses the DAEMON_KILLED_SIGNATURE constant (not a <step>/<class> shape) and
  // the batch-restart action, consistent with error-kinds.ts conventions.
  {
    signature: DAEMON_KILLED_SIGNATURE,
    warmTitle: 'Mars was shut down while this task was still running',
    verboseReason:
      'The task was in flight when the Mars daemon was killed; the work is not lost and the task can be re-queued from setup.',
    actions: DAEMON_KILLED_ACTIONS,
  },
])

/** Lookup map built once from the registry for O(1) access. */
const _INDEX: Readonly<Map<string, FailureKind>> = Object.freeze(
  new Map(FAILURE_KINDS.map((k) => [k.signature, k])),
)

/**
 * Look up a failure-kind record by its exact `<failingStep>/<error-class>`
 * signature. Returns `null` when no entry is registered for that signature —
 * callers should fall through to `unknownFailureKind` on miss.
 */
export const lookupFailureKind = (signature: string): FailureKind | null =>
  _INDEX.get(signature) ?? null

/**
 * Extract the failing step from a `<failingStep>/<error-class>` signature.
 * Returns `'unknown'` when `sig` is null.
 *
 * Examples:
 *   `'verify:test/unclassified'` → `'verify:test'`
 *   `'daemon-killed'` → `'daemon-killed'`
 *   `null` → `'unknown'`
 */
export const failingStepFromSignature = (sig: string | null): string => {
  if (sig === null) return 'unknown'
  const idx = sig.indexOf('/')
  return idx === -1 ? sig : sig.slice(0, idx)
}

/**
 * Synthesise a FailureKind for a signature that is not in the registry.
 *
 * `warmTitle` names the failing step so the operator knows where to look.
 * `verboseReason` opens with the first non-blank line of the captured error
 * output so the operator has an immediate hint without opening the transcript.
 */
export const unknownFailureKind = (
  failingStep: string,
  capturedError: string,
): FailureKind => {
  const errorHead = firstNonBlankLine(capturedError)
  return {
    signature: `${failingStep}/unknown`,
    warmTitle: `The ${failingStep} step failed — see the transcript`,
    verboseReason: errorHead.length > 0
      ? errorHead
      : `The ${failingStep} step failed with an unrecognised error.`,
    actions: DEFAULT_ACTIONS,
  }
}
