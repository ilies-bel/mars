/**
 * Failure-kind registry — the single signature-keyed record for code, human
 * reason, recipe, and recovery actions (ADR-0042, superseding ADR-0035's
 * ErrorKind-id keying).
 *
 * Each record is keyed by the failure signature `<failingStep>/<error-class>`
 * (ADR-0002) and bundles everything the system needs to present a failure to a
 * human and recover from it:
 *
 *   - `signature`     — the `<failingStep>/<error-class>` key.
 *   - `warmTitle`     — short plain-English title for the action queue list row.
 *   - `verboseReason` — one-sentence calm explanation for the detail pane.
 *   - `recipe`        — the recovery-recipe reference (a `fix-recipes.ts`
 *                       signature) or `null` when no recipe is registered.
 *   - `actions`       — the ordered recovery action menu (declarative
 *                       descriptors — data, never functions — so they
 *                       serialise to the browser as-is).
 *
 * The signature is the key because it is the only one of the three former
 * keyings that captures substep granularity and because recovery recipes
 * already bind to it. This collapses the former three drifting layers
 * (code-keyed failure-reason catalog, errorKind-id registry, signature-keyed
 * humanisation) into one record so code, human reason, recipe, and actions are
 * authored together.
 *
 * This module is pure data with no runtime side-effects.
 *
 * Adding a new entry:
 *   1. Add the error-class rule to `failure-signature.ts` (if the class is new).
 *   2. Add a `FailureKind` entry to `FAILURE_KINDS` below.
 *   3. The `lookupFailureKind` function picks it up automatically.
 */

import { firstNonBlankLine } from './failure-signature'
import { hasRecipe } from './fix-recipes'
import { DAEMON_KILLED_SIGNATURE } from './retry-budget'

/**
 * The verbs a recovery action can ask the daemon to perform. Each maps to a
 * route on the daemon's local HTTP server (see `daemon/http-server.ts`).
 *
 * - `restart`                  — tear down the worktree/branch and re-queue
 *                                from setup (per-task).
 * - `unblock`                  — phantom-recover a blocked task: clear its
 *                                edges and flip it to failed so it can be
 *                                restarted or purged.
 * - `purge`                    — drop the task and its worktree permanently.
 * - `prune-worktree`           — remove a leftover worktree whose task is
 *                                terminal/absent.
 * - `investigate`              — run a cheap Haiku read-only investigation over
 *                                a stale worktree's diff; persists an
 *                                explanation onto the action queue item.
 * - `diagnose-failure`         — run a one-shot Sonnet root-cause diagnosis on a
 *                                failed task whose signature has no registered
 *                                recipe; persists a diagnosis onto the action
 *                                queue item. Operator-triggered.
 * - `restart-daemon`           — process-level: re-exec the daemon itself.
 * - `restart-all-daemon-killed`— batch: re-queue every failed task that carries
 *                                the daemon-killed signature in one request.
 * - `shape`                    — no daemon verb; a hint to run a skill
 *                                (`/mars:grill`). Rendered as guidance, not a
 *                                one-click button.
 */
export type ActionOp =
  | 'restart'
  | 'unblock'
  | 'purge'
  | 'prune-worktree'
  | 'investigate'
  | 'diagnose-failure'
  | 'restart-daemon'
  | 'restart-all-daemon-killed'
  | 'shape'

/**
 * A declarative recovery action. No executable code — the daemon owns the
 * behaviour behind `op`; this is the intent the UI renders and proxies. Data,
 * not functions, so it serialises over the daemon HTTP layer to the browser.
 */
export interface ActionDescriptor {
  /** Stable id, unique within a kind's action list. */
  id: string
  /** Operator-facing button label. */
  label: string
  /** The daemon verb this action invokes. */
  op: ActionOp
  /**
   * When true, the UI must confirm before invoking (destructive or
   * process-level actions: purge, restart-daemon).
   */
  needsConfirm?: boolean
  /**
   * For `op: 'shape'` only — the skill/command the operator should run, since
   * there is no daemon verb to call. Ignored for every other op.
   */
  hint?: string
}

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
  /**
   * Reference to the recovery recipe (a `fix-recipes.ts` signature) that the
   * orchestrator dispatches for this failure, or `null` when no recipe is
   * registered (the failure routes to operator triage / the Investigator).
   * Recipes are keyed by the same signature, so when a recipe exists this
   * equals `signature`; it is a reference, never a copy of the recipe body.
   */
  recipe: string | null
  /** Ordered recovery action menu rendered by the UI. */
  actions: ActionDescriptor[]
}

/**
 * Default action menu for a failed task: investigate (one-shot diagnosis),
 * restart from scratch, or drop permanently.
 */
const DEFAULT_ACTIONS: ActionDescriptor[] = [
  { id: 'diagnose-failure', label: 'Investigate', op: 'diagnose-failure' },
  { id: 'restart', label: 'Restart from scratch', op: 'restart' },
  { id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true },
]

/**
 * Recovery menu for daemon-killed tasks: requeue this one, or batch-restart all
 * affected tasks. This is the ADR-0035 daemon-killed special-case re-expressed
 * on the signature keying — one row kind (`failed-task` carrying the
 * daemon-killed signature) carrying a requeue-framed menu rather than the
 * generic failure menu.
 */
const DAEMON_KILLED_ACTIONS: ActionDescriptor[] = [
  { id: 'requeue', label: 'Requeue now', op: 'restart' },
  {
    id: 'restart-all',
    label: 'Restart all daemon-killed',
    op: 'restart-all-daemon-killed',
  },
  {
    id: 'restart-daemon',
    label: 'Restart daemon',
    op: 'restart-daemon',
    needsConfirm: true,
  },
]

/**
 * Compute the recipe reference for a signature: the signature itself when a
 * recovery recipe is registered for it, otherwise `null`. Keeps the `recipe`
 * field a reference into `fix-recipes.ts` rather than a duplicated body.
 */
const recipeRef = (signature: string): string | null =>
  hasRecipe(signature) ? signature : null

/**
 * The registry. Every named failure cause the action queue can present as a
 * warm, human-readable failure card is listed here.
 *
 * Ordering is informational only; lookups use a signature-keyed map.
 */
export const FAILURE_KINDS: readonly FailureKind[] = Object.freeze(
  (
    [
      // ── setup:install ────────────────────────────────────────────────────
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

      // ── code:no-edits-made ───────────────────────────────────────────────
      {
        signature: 'code:no-edits-made/unclassified',
        warmTitle: 'The coder stopped before starting to write',
        verboseReason:
          'The code step completed without producing any file changes; the coder may have misunderstood the task or encountered an unrecognised error.',
        actions: DEFAULT_ACTIONS,
      },

      // ── verify:has-diff ──────────────────────────────────────────────────
      {
        signature: 'verify:has-diff/no-commits-ahead',
        warmTitle: 'The coder stopped mid-task',
        verboseReason:
          'The verify step found no commits ahead of the integration branch; the coder made changes but did not commit them.',
        actions: DEFAULT_ACTIONS,
      },

      // ── code:timeout ─────────────────────────────────────────────────────
      // One entry covers the SIGKILL / exit-137 class: the coding worker was
      // terminated by the wall-clock watchdog.
      {
        signature: 'code:timeout/install-timeout',
        warmTitle: 'The coder took too long',
        verboseReason:
          'The code step was killed (SIGKILL / exit 137) because it exceeded its wall-clock time budget.',
        actions: DEFAULT_ACTIONS,
      },

      // ── code:over-budget ─────────────────────────────────────────────────
      {
        signature: 'code:over-budget/unclassified',
        warmTitle: 'The task was too large for the coder to finish in one run',
        verboseReason:
          'The code step exhausted its token budget before completing the task; consider splitting the work into smaller slices.',
        actions: DEFAULT_ACTIONS,
      },

      // ── code:context-exhausted ───────────────────────────────────────────
      // The coder was killed by the context-budget ceiling (exitCode 138,
      // stderr "context budget exhausted"). The task is too large to complete
      // in one pass — a verbatim restart will exhaust again. Primary recovery
      // action is re-slice / narrow scope; restart is secondary.
      //
      // NOTE: no cliHint for re-slice because no task-level re-slice CLI verb
      // exists yet. A task-level `mars reslice <id>` verb is a follow-up.
      {
        signature: 'code:context-exhausted',
        warmTitle: 'The coder ran out of context window before finishing',
        verboseReason:
          'The coder ran out of context window (token budget) before finishing. The task is likely too large to complete in one pass; consider splitting it into smaller tasks.',
        actions: [
          // Re-slice is first: restarting verbatim will exhaust again.
          // op: 'shape' = guidance-only (no daemon verb); cliHint is null
          // until a task-level re-slice verb is implemented.
          { id: 're-slice', label: 'Re-slice into smaller tasks', op: 'shape' as const },
          { id: 'restart', label: 'Restart from scratch', op: 'restart' as const },
          { id: 'purge', label: 'Drop permanently', op: 'purge' as const, needsConfirm: true },
        ],
      },

      // ── verify:typecheck ─────────────────────────────────────────────────
      // One entry per registered typecheck-* error-class slug in
      // failure-signature.ts, plus a generic unclassified fallback.
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

      // ── merge:vcs-supervisor-aborted ─────────────────────────────────────
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
    ] satisfies ReadonlyArray<Omit<FailureKind, 'recipe'>>
  )
    .map((k) => ({ ...k, recipe: recipeRef(k.signature) }))
    .concat([
      // ── daemon-killed ──────────────────────────────────────────────────────
      // Uses the DAEMON_KILLED_SIGNATURE constant (not a <step>/<class> shape)
      // and the requeue/batch-restart menu. No recovery recipe: the daemon
      // raises an alert and the operator requeues.
      {
        signature: DAEMON_KILLED_SIGNATURE,
        warmTitle: 'Mars was shut down while this task was still running',
        verboseReason:
          'The task was in flight when the Mars daemon was killed; the work is not lost and the task can be re-queued from setup.',
        recipe: null,
        actions: DAEMON_KILLED_ACTIONS,
      },
    ]),
)

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
    recipe: null,
    actions: [
      { id: 'diagnose-failure', label: 'Investigate', op: 'diagnose-failure' },
      { id: 'restart', label: 'Restart from scratch', op: 'restart' },
      { id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true },
    ],
  }
}

/**
 * Resolve a task's failure to its FailureKind record from the structured
 * `failureSignature` written at failure time. This is the resolution path
 * ADR-0042 mandates: it keys on the structured signature, NOT on a re-grep of
 * the raw failure string, so a failure whose step and cause are known resolves
 * to its real record instead of collapsing to `unknown`.
 *
 * - A registered signature resolves to its `FAILURE_KINDS` entry.
 * - An unregistered or null signature synthesises an `unknownFailureKind`
 *   naming the failing step (derived from the signature, or `'unknown'`).
 */
export const resolveFailureKind = (
  signature: string | null,
  capturedError = '',
): FailureKind => {
  if (signature !== null) {
    const hit = lookupFailureKind(signature)
    if (hit) return hit
    return unknownFailureKind(failingStepFromSignature(signature), capturedError)
  }
  return unknownFailureKind('unknown', capturedError)
}

/**
 * Legacy free-text bridge: maps a bare `failureReasonCode` string (as stamped
 * by older workflow write-paths before the `code:` prefix convention was
 * introduced) to the canonical catalog signature.
 *
 * Returns `null` when the string does not match any known legacy code — the
 * caller should treat `null` as an unrecognised code and fall through to the
 * `unknown` path.
 *
 * Rules are ordered from most-specific to least-specific to avoid a generic
 * substring swallowing a more precise match.
 */
export const failureReasonStringToCode = (reasonStr: string): string | null => {
  // context-exhausted: bare code, underscore variant, or full stderr phrase
  if (
    reasonStr.includes('context-exhausted') ||
    reasonStr.includes('context_exhausted') ||
    reasonStr.includes('context budget exhausted')
  ) {
    return 'code:context-exhausted'
  }
  return null
}
