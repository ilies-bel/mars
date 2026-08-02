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

import {
  firstNonBlankLine,
  stripRecoveryFailedPrefixes,
} from './failure-signature'
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
 * - `copy`                     — client-side only; the UI copies `hint` verbatim
 *                                to the clipboard. Must NEVER reach the daemon.
 * - `dismiss`                  — dismiss a draft proposal: flips its status from
 *                                `draft` → `dismissed` and drops the action-queue
 *                                row.
 * - `validate`                 — approve a task parked at the preview gate: kill
 *                                its dev server, mark it validated, and re-queue
 *                                so the merge continuation runs (per-task).
 * - `reject`                   — reject a task parked at the preview gate: kill
 *                                its dev server and fail the task (worktree
 *                                preserved); nothing merges (per-task).
 * - `land-work`                 — fast-forward (or cherry-pick) a task branch's
 *                                ahead commits onto the integration branch, then
 *                                resolve the worktree-ahead action-queue row.
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
  | 'copy'
  | 'dismiss'
  | 'validate'
  | 'reject'
  | 'run-reflect'
  | 'enable-auto-reflect'
  | 'land-work'

/**
 * The auto-encodable check families of the gate-enrichment pipeline
 * (PRD 745f33e0). A failure class is only auto-encodable when a deterministic,
 * command-shaped predicate over the worktree/diff can catch it:
 *
 * - `command`         — command-reproducible failures: the failing
 *                       typecheck/lint/test command narrowed to the scope that
 *                       failed, re-run as a required verify step.
 * - `pattern`         — diff/worktree pattern assertions: forbidden constructs
 *                       detectable by a deterministic scan (exit-code-masking
 *                       pipes, reintroduced `@mastra/*` imports, committed
 *                       debris) — the data-driven successors to the hardcoded
 *                       TSC_DECOY_MARKER / VERIFY_INFRA_FAILURE_PATTERNS
 *                       constants in verify.ts.
 * - `regression-test` — agent-authored regression tests committed to the repo
 *                       and referenced by a scoped verify step.
 */
export type EncodableFamily = 'command' | 'pattern' | 'regression-test'

/**
 * Why a failure class canNOT become a static check. Every non-encodable class
 * carries an explicit reason so the gate's monotonic-coverage boundary is
 * enumerable, never silent:
 *
 * - `semantic`      — compiles, passes tests, does the wrong thing. That is
 *                     behaviour verification (separate proposal 48e50df0), not
 *                     a deterministic predicate.
 * - `environmental` — rate limits, infra flakes, watchdog kills; already
 *                     pattern-excluded from real failures.
 * - `orchestration` — pipeline-step failures (merge:dirty-target,
 *                     setup:install-failed, …): recovery-recipe territory
 *                     (ADR-0002), not gate content.
 * - `prompt-misread`— one-off agent misunderstandings of the task prompt.
 * - `unclassified`  — signature not yet classified; recorded so the gap stays
 *                     visible.
 */
export type NonEncodableReason =
  | 'semantic'
  | 'environmental'
  | 'orchestration'
  | 'prompt-misread'
  | 'unclassified'

/**
 * The static-encodability facet on a {@link FailureKind} (PRD 745f33e0,
 * extending ADR-0042's single signature-keyed record). Either the class is
 * auto-encodable into one of the three check families, or it is explicitly
 * marked non-encodable with a reason. There is no third state: gaps must be
 * enumerable, never silent.
 */
export type StaticEncodability =
  | { encodable: true; family: EncodableFamily }
  | { encodable: false; reason: NonEncodableReason }

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
   * For `op: 'copy'` only — the fully-qualified runnable command the UI copies
   * to the clipboard (e.g. `/mars:grill <proposalId>`). Ignored for every other op.
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
  /**
   * Whether this failure class can be encoded as a signature-keyed static
   * verify check (the gate-enrichment pipeline, PRD 745f33e0). Required on
   * every record so the coverage boundary of the self-enriching gate is
   * enumerable at the type level — a new FailureKind cannot be added without
   * declaring where it stands.
   */
  staticEncodable: StaticEncodability
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
 * Recovery menu for worktree-missing failures: the worktree is gone so there
 * is nothing to diagnose — only restart (re-provision from scratch) or purge
 * are meaningful. Used by every FailureKind whose root cause is a missing or
 * irrecoverable worktree/branch/origin state.
 */
export const WORKTREE_MISSING_ACTIONS: ActionDescriptor[] = [
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

/** Shorthand: the class is command-reproducible (family (a) of PRD 745f33e0). */
const ENCODABLE_COMMAND: StaticEncodability = {
  encodable: true,
  family: 'command',
}

/** Shorthand: the class is explicitly NOT statically encodable. */
const notEncodable = (reason: NonEncodableReason): StaticEncodability => ({
  encodable: false,
  reason,
})

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
        staticEncodable: notEncodable('orchestration'),
        warmTitle: 'The coding environment could not be set up',
        verboseReason:
          'The setup step could not install dependencies because the lockfile no longer matches the manifest.',
        actions: DEFAULT_ACTIONS,
      },
      {
        signature: 'setup:install/install-timeout',
        staticEncodable: notEncodable('environmental'),
        warmTitle: 'The coding environment could not be set up',
        verboseReason:
          'The setup step timed out (SIGKILL / exit 137) while installing dependencies.',
        actions: DEFAULT_ACTIONS,
      },
      {
        signature: 'setup:install/install-missing-peer',
        staticEncodable: notEncodable('orchestration'),
        warmTitle: 'The coding environment could not be set up',
        verboseReason:
          'The setup step could not install dependencies because a required peer dependency is missing from the manifest.',
        actions: DEFAULT_ACTIONS,
      },
      {
        signature: 'setup:install/unclassified',
        staticEncodable: notEncodable('orchestration'),
        warmTitle: 'The coding environment could not be set up',
        verboseReason:
          'The setup step could not install dependencies; the error did not match any known pattern. See the transcript for details.',
        actions: DEFAULT_ACTIONS,
      },

      // ── code:coder-exit-nonzero ──────────────────────────────────────────
      // The coder process exited non-zero without doing any of its work.
      // The api-unreachable sub-class is the only named entry: when Claude's
      // API is unreachable at the network level the coder exits immediately
      // with no code changes and the cause is environmental, not a code
      // defect. handleTaskFailureWithFixTask re-queues (never spawns recovery)
      // for this signature so the slot is not burned on a doomed fix task.
      {
        signature: 'code:coder-exit-nonzero/api-unreachable',
        staticEncodable: notEncodable('environmental'),
        warmTitle: "The coder couldn't reach Claude's API",
        verboseReason:
          "The code step failed because the coder process could not connect to Claude's API (network or DNS error) — the task code was not at fault. The task has been re-queued and will retry once connectivity is restored.",
        actions: [
          { id: 'restart', label: 'Restart from scratch', op: 'restart' },
          { id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true },
        ],
      },

      {
        // The command spawned for the coder could not be executed at all —
        // spawn ENOENT/EACCES, or exit 127. Environmental, not a code defect:
        // the step did no work, so a recovery fixer has nothing to fix.
        signature: 'code:coder-exit-nonzero/provider-binary-missing',
        staticEncodable: notEncodable('environmental'),
        warmTitle: "The daemon could not run the coding assistant's CLI",
        verboseReason:
          "The code step died in milliseconds because the command spawned for the coder could not be executed (spawn failure, or exit code 127 — command not found). Nothing about the task's code is at fault. Check that the worker provider's binary resolves in the daemon's own environment — `which` in an interactive shell proves nothing about it — or pin the provider's MARS_*_BIN override to an absolute path.",
        actions: [
          {
            id: 'restart-daemon',
            label: 'Restart daemon',
            op: 'restart-daemon',
            needsConfirm: true,
          },
          { id: 'restart', label: 'Restart from scratch', op: 'restart' },
          { id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true },
        ],
      },
      {
        // The commit gate was denied a write into <repo>/.git/worktrees/<id>/.
        // Environmental and operator-owned: no code change can fix a sandbox
        // denial, and a recovery fixer would fail for exactly the same reason,
        // so there is no recipe and the menu offers no "fix it" option.
        signature: 'code:coder-exit-nonzero/git-metadata-denied',
        staticEncodable: notEncodable('environmental'),
        warmTitle: "The daemon cannot write the repository's git metadata",
        verboseReason:
          "The coder edited files and ran tests successfully but could not commit: writing into <repo>/.git/worktrees/<id>/ was denied (index.lock, Operation not permitted). The daemon was started from a shell that lacks write access to the repository's shared git directory — a different location from the task worktree. Restart the daemon from a shell with write access to that directory; until then every task will fail the same way.",
        actions: [
          {
            id: 'restart-daemon',
            label: 'Restart daemon',
            op: 'restart-daemon',
            needsConfirm: true,
          },
          { id: 'restart', label: 'Restart from scratch', op: 'restart' },
          { id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true },
        ],
      },

      // ── code:no-edits-made ───────────────────────────────────────────────
      {
        signature: 'code:no-edits-made/unclassified',
        staticEncodable: notEncodable('prompt-misread'),
        warmTitle: 'The coder stopped before starting to write',
        verboseReason:
          'The code step completed without producing any file changes; the coder may have misunderstood the task or encountered an unrecognised error.',
        actions: DEFAULT_ACTIONS,
      },

      // ── verify:has-diff ──────────────────────────────────────────────────
      {
        signature: 'verify:has-diff/no-commits-ahead',
        staticEncodable: notEncodable('prompt-misread'),
        warmTitle: 'The coder stopped mid-task',
        verboseReason:
          'The verify step found no commits ahead of the integration branch; the coder made changes but did not commit them.',
        actions: DEFAULT_ACTIONS,
      },

      // ── verify:worktree-hygiene ──────────────────────────────────────────
      // The pre-verify hygiene probe, reported under its OWN step name. These
      // were `verify:has-diff/*` until the probe stopped borrowing the
      // has-diff label: a missing worktree, a drifted branch and stale rebase
      // state are all conditions in which the diff was never examined at all,
      // so filing them as diff verdicts made every one of them read as "the
      // coder produced nothing".
      {
        signature: 'verify:worktree-hygiene/worktree-missing',
        staticEncodable: notEncodable('environmental'),
        warmTitle: 'Task worktree disappeared before verify could run',
        verboseReason:
          "The verify step could not inspect a diff because the task's worktree was gone (likely pruned by a daemon restart or recover sweep while the task was in flight). This is an infrastructure condition, not a coder error — the task can be restarted.",
        actions: WORKTREE_MISSING_ACTIONS,
      },
      {
        signature: 'verify:worktree-hygiene/branch-drift',
        staticEncodable: notEncodable('environmental'),
        warmTitle: 'Verify aborted: task worktree is on the wrong branch',
        verboseReason:
          'The verify hygiene check found a different branch checked out in the task worktree than the task branch recorded in the database. This is an infrastructure condition, not a coder error — the task can be restarted.',
        actions: WORKTREE_MISSING_ACTIONS,
      },
      {
        signature: 'verify:worktree-hygiene/stale-rebase-state',
        staticEncodable: notEncodable('environmental'),
        warmTitle: 'Verify aborted: stale rebase state in task worktree',
        verboseReason:
          'The verify hygiene check detected a stale git rebase state directory (rebase-merge or rebase-apply) in the task worktree, left over from a previously interrupted rebase. This is an infrastructure condition, not a coder error — the task can be restarted.',
        actions: WORKTREE_MISSING_ACTIONS,
      },
      // ── verify:worktree-missing ──────────────────────────────────────────
      // The verify-step resume preflight found the worktree directory gone and
      // its branch deleted — almost always because a recovery sharing the
      // ORIGIN's worktree merged and cleanup reclaimed it (see
      // `findLiveWorktreeDependents`, which now prevents that).
      //
      // MUST be `environmental`. It is a per-task, expected, self-limiting
      // condition, and `isEnvironmentalSignature` is what keeps such a
      // condition from feeding the signature-storm streak: without it, one
      // reclaimed worktree affecting three tasks reads as a systemic storm and
      // PAUSES THE WHOLE QUEUE — which is exactly what happened. Environmental
      // also buys the right remedy: auto-restart (restart nulls
      // branch/worktreePath, so setup carves a fresh worktree), with an
      // `env-incident` row rather than a pause once the cap is hit.
      {
        signature: 'verify:worktree-missing/unclassified',
        staticEncodable: notEncodable('environmental'),
        warmTitle: 'Task worktree was reclaimed before verify could run',
        verboseReason:
          "The verify step found the task's worktree directory gone and its branch deleted, so there was nothing left to verify in place. This usually means a recovery sharing the worktree merged and cleanup reclaimed it. Infrastructure, not a coder error — the task is restarted onto a fresh worktree.",
        actions: WORKTREE_MISSING_ACTIONS,
      },
      {
        signature: 'verify:worktree-hygiene/unclassified',
        staticEncodable: notEncodable('environmental'),
        warmTitle: 'Verify aborted: the task worktree failed its health check',
        verboseReason:
          'The pre-verify hygiene probe rejected the task worktree for a reason with no registered error class. The diff was never inspected, so this is not a statement about the coder’s work.',
        actions: WORKTREE_MISSING_ACTIONS,
      },
      {
        signature: 'verify:has-diff/unclassified',
        staticEncodable: notEncodable('orchestration'),
        warmTitle: 'The coder did not produce any changes',
        verboseReason:
          'The verify step could not confirm that file changes were produced. The coder may have encountered an error or misunderstood the task.',
        actions: DEFAULT_ACTIONS,
      },

      // ── code:timeout ─────────────────────────────────────────────────────
      // One entry covers the SIGKILL / exit-137 class: the coding worker was
      // terminated by the wall-clock watchdog.
      {
        signature: 'code:timeout/install-timeout',
        staticEncodable: notEncodable('environmental'),
        warmTitle: 'The coder took too long',
        verboseReason:
          'The code step was killed (SIGKILL / exit 137) because it exceeded its wall-clock time budget.',
        actions: DEFAULT_ACTIONS,
      },

      // ── code:over-budget ─────────────────────────────────────────────────
      {
        signature: 'code:over-budget/unclassified',
        staticEncodable: notEncodable('orchestration'),
        warmTitle: 'The task was too large for the coder to finish in one run',
        verboseReason:
          'The code step exhausted its token budget before completing the task; consider splitting the work into smaller slices.',
        actions: DEFAULT_ACTIONS,
      },

      // ── code:commit-contract ─────────────────────────────────────────────
      // The coder committed some work but exited without committing every path.
      // The gate (`detectPostCoderState` → `dirty-with-commits`) catches this
      // before verify runs. A recovery fix task is dispatched with the
      // purpose-built recipe to commit the remaining paths.
      {
        signature: 'code:commit-contract/uncommitted-changes',
        staticEncodable: notEncodable('orchestration'),
        warmTitle: 'The coder left some files uncommitted',
        verboseReason:
          'The code step completed with commits ahead of integration, but some file paths were still uncommitted in the worktree when the coder exited. A recovery task has been dispatched to commit the remaining paths.',
        actions: DEFAULT_ACTIONS,
      },

      // ── verify:typecheck ─────────────────────────────────────────────────
      // One entry per registered typecheck-* error-class slug in
      // failure-signature.ts, plus a generic unclassified fallback.
      {
        signature: 'verify:typecheck/typecheck-property-not-exist',
        staticEncodable: ENCODABLE_COMMAND,
        warmTitle: 'The changes did not pass type-checking',
        verboseReason:
          'The verify step failed because one or more properties accessed in the code do not exist on the declared type (TS2339 / TS2353).',
        actions: DEFAULT_ACTIONS,
      },
      {
        signature: 'verify:typecheck/typecheck-cannot-find-name',
        staticEncodable: ENCODABLE_COMMAND,
        warmTitle: 'The changes did not pass type-checking',
        verboseReason:
          'The verify step failed because the code references a name that is not in scope (TS2304).',
        actions: DEFAULT_ACTIONS,
      },
      {
        signature: 'verify:typecheck/typecheck-cannot-find-module',
        staticEncodable: ENCODABLE_COMMAND,
        warmTitle: 'The changes did not pass type-checking',
        verboseReason:
          'The verify step failed because an import could not be resolved to a known module (TS2307).',
        actions: DEFAULT_ACTIONS,
      },
      {
        signature: 'verify:typecheck/typecheck-type-mismatch',
        staticEncodable: ENCODABLE_COMMAND,
        warmTitle: 'The changes did not pass type-checking',
        verboseReason:
          'The verify step failed because a value was assigned to an incompatible type (TS2322).',
        actions: DEFAULT_ACTIONS,
      },
      {
        signature: 'verify:typecheck/typecheck-arg-type-mismatch',
        staticEncodable: ENCODABLE_COMMAND,
        warmTitle: 'The changes did not pass type-checking',
        verboseReason:
          'The verify step failed because a function argument has a type incompatible with the declared parameter (TS2345).',
        actions: DEFAULT_ACTIONS,
      },
      {
        signature: 'verify:typecheck/typecheck-excess-property',
        staticEncodable: ENCODABLE_COMMAND,
        warmTitle: 'The changes did not pass type-checking',
        verboseReason:
          'The verify step failed because an object literal contains a property that does not exist in the target type (TS2353 excess-property check).',
        actions: DEFAULT_ACTIONS,
      },
      {
        signature: 'verify:typecheck/typecheck-missing-export',
        staticEncodable: ENCODABLE_COMMAND,
        warmTitle: 'The changes did not pass type-checking',
        verboseReason:
          'The verify step failed because the code imports a named export that does not exist in the target module (TS2694).',
        actions: DEFAULT_ACTIONS,
      },
      {
        signature: 'verify:typecheck/unclassified',
        staticEncodable: ENCODABLE_COMMAND,
        warmTitle: 'The changes did not pass type-checking',
        verboseReason:
          'The verify step failed during type-checking with an error pattern that has not yet been classified.',
        actions: DEFAULT_ACTIONS,
      },

      // ── verify:killed ───────────────────────────────────────────────────
      // A 128+signal exit is process death, not evidence that the command
      // which happened to be running failed. These signatures auto-requeue
      // through the environmental restart path instead of spending the task's
      // single recovery attempt on a non-existent code defect.
      {
        signature: 'verify:killed/sigterm',
        staticEncodable: notEncodable('environmental'),
        warmTitle: 'Verification was killed before it could finish',
        verboseReason:
          'The verification process received SIGTERM before reporting a result. The task is re-queued so verification can run again.',
        actions: DEFAULT_ACTIONS,
      },
      {
        signature: 'verify:killed/sigkill',
        staticEncodable: notEncodable('environmental'),
        warmTitle: 'Verification was killed before it could finish',
        verboseReason:
          'The verification process received SIGKILL before reporting a result. This commonly indicates host memory pressure; the task is re-queued so verification can run again.',
        actions: DEFAULT_ACTIONS,
      },

      // ── verify:test ──────────────────────────────────────────────────────
      // The verify step ran the project's test suite and it failed. The
      // assertion sub-class has a registered recovery recipe of the same
      // signature (fix-recipes.ts) — without this entry the action queue
      // rendered it as an unregistered failure even though self-heal knew
      // exactly how to fix it.
      {
        signature: 'verify:test/test-assertion-error',
        staticEncodable: ENCODABLE_COMMAND,
        warmTitle: 'The changes did not pass the tests',
        verboseReason:
          'The verify step ran the test suite and an assertion failed — the implementation does not produce what the tests expect. A recovery task fixes the implementation without touching the test files.',
        actions: DEFAULT_ACTIONS,
      },

      // ── code/uncommitted-changes ─────────────────────────────────────────
      // The coder exited cleanly but left real work uncommitted in the
      // worktree AND the orchestrator's deterministic auto-commit
      // (autoCommitWorktreeIfDeterministic) could not land it either — a
      // pre-commit hook rejected it, nothing was stageable, or git refused
      // the commit. The work is still on disk in the worktree; recovery has
      // to clear whatever blocked the commit and land it.
      {
        signature: 'code/uncommitted-changes',
        staticEncodable: notEncodable('orchestration'),
        warmTitle: 'The coder left work uncommitted and it could not be committed automatically',
        verboseReason:
          "The code step finished with changes still uncommitted in the task worktree, and the orchestrator's automatic commit was refused (commonly a pre-commit hook, or nothing stageable). The work is still on disk; a recovery task clears the blocker and commits it.",
        actions: DEFAULT_ACTIONS,
      },

      // ── behaviour-verify:dod-unmet ───────────────────────────────────────
      // Behaviour verification (the pre-merge behaviour-verify step) reached
      // the live surface and found a Definition-of-Done criterion observably
      // contradicted, with screenshot evidence. Exactly one recovery Chore is
      // spawned from the recipe registered under this same signature
      // (ADR-0002); un-verifiability never lands here — it degrades to a
      // draft proposal + behaviour-unverified action-queue row instead.
      {
        signature: 'behaviour-verify:dod-unmet/dod-unmet',
        // Behavioural/Definition-of-Done contradiction is the canonical
        // non-static-encodable class (a live-surface semantic failure the
        // static gate cannot assert) — it is precisely what behaviour-verify
        // exists to catch, so it can never become a self-enrichment check.
        staticEncodable: notEncodable('semantic'),
        warmTitle: 'The change ran, but did not do what the task asked for',
        verboseReason:
          "The behaviour-verify step drove the task's live preview through a browser and observed at least one Definition-of-Done criterion contradicted on the running surface (screenshots captured); the merge was stopped and a recovery task was spawned to close the gap.",
        actions: DEFAULT_ACTIONS,
      },

      // ── merge:vcs-supervisor-aborted ─────────────────────────────────────
      {
        signature: 'merge:vcs-supervisor-aborted/merge-conflict-unresolved',
        staticEncodable: notEncodable('orchestration'),
        warmTitle: 'The changes clashed with main and were too hard to merge',
        verboseReason:
          'The merge step was aborted by the VCS supervisor because a conflict between the task branch and the integration branch could not be automatically resolved.',
        actions: DEFAULT_ACTIONS,
      },
      {
        signature: 'merge:vcs-supervisor-aborted/rebase-dirty-worktree',
        staticEncodable: notEncodable('orchestration'),
        warmTitle: 'The task worktree had uncommitted changes when the rebase started',
        verboseReason:
          'The merge step was aborted because the task worktree contained uncommitted or untracked files that prevented the rebase from starting. This is a worktree hygiene condition, not a code defect; restarting re-provisions the worktree from scratch.',
        actions: WORKTREE_MISSING_ACTIONS,
      },
      {
        // merge:vcs-supervisor-aborted/rebase-no-in-progress-state fires when
        // mergeBranch's guard detects that git rebase exited non-zero WITHOUT
        // leaving a rebase-merge/ or rebase-apply/ state directory on disk.
        // This means git aborted the rebase before it could conflict (e.g.
        // uncommitted changes in the worktree blocked the rebase, an invalid
        // upstream ref, or an empty-commit stop). This is a git
        // worktree/rebase-state condition, not a code defect; restarting
        // re-provisions the worktree from scratch.
        signature: 'merge:vcs-supervisor-aborted/rebase-no-in-progress-state',
        staticEncodable: notEncodable('orchestration'),
        warmTitle: 'The rebase could not start (no in-progress state)',
        verboseReason:
          'The merge step was aborted because git rebase exited non-zero without leaving a rebase state directory on disk — the worktree or ref state prevented the rebase from starting. This is a git worktree/rebase-state condition, not a code defect; restarting re-provisions the worktree from scratch.',
        actions: WORKTREE_MISSING_ACTIONS,
      },
      {
        signature: 'merge:vcs-supervisor-aborted/unclassified',
        staticEncodable: notEncodable('orchestration'),
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
        staticEncodable: notEncodable('environmental'),
        warmTitle: 'Mars was shut down while this task was still running',
        verboseReason:
          'The task was in flight when the Mars daemon was killed; the work is not lost and the task can be re-queued from setup.',
        recipe: null,
        actions: DAEMON_KILLED_ACTIONS,
      },
      // ── requeue:time-bound-exceeded/unclassified ─────────────────────────
      // The poll fallback stopped re-dispatching this task after it exceeded
      // its retry-time ceiling. This is often operational rather than a code
      // defect: pausing or restarting Mars can leave queued work old enough to
      // breach the bound on the next poll. There is no mechanical fix recipe;
      // keep the normal investigate/restart/drop choices available.
      {
        signature: 'requeue:time-bound-exceeded/unclassified',
        staticEncodable: notEncodable('orchestration'),
        warmTitle: 'The task was repeatedly re-dispatched but did not finish',
        verboseReason:
          'The task was re-dispatched repeatedly without completing. This can happen when Mars was paused or restarted and queued work aged past its time limit; investigate the task, then restart it to try again.',
        recipe: null,
        actions: DEFAULT_ACTIONS,
      },
      // ── orchestration:main-committer-still-dirty ───────────────────────────
      // Raised when the post-verify clean check finds the integration branch
      // still dirty after the main-committer task ran. This is an orchestration
      // condition — not a code defect — so there is no recovery recipe and no
      // fix task is spawned. The operator must resolve the dirty state manually.
      {
        signature: 'orchestration:main-committer-still-dirty',
        staticEncodable: notEncodable('orchestration'),
        warmTitle: 'Integration branch still dirty after main-committer ran',
        verboseReason:
          'The main-committer task completed but left uncommitted files on the integration branch; no automatic recovery is possible — operator review required.',
        recipe: null,
        actions: [
          { id: 'diagnose-failure', label: 'Investigate', op: 'diagnose-failure' },
          { id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true },
        ],
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
 * Returns `true` when `signature` is registered in the failure-kinds registry
 * with `staticEncodable: notEncodable('environmental')`.
 *
 * Use this as the single source of truth for "is this failure an
 * infrastructure condition?" — never maintain a parallel list of signatures.
 * Unregistered signatures return `false` (treated as non-environmental so
 * unexpected failures still flow through the normal recovery path).
 */
export const isEnvironmentalSignature = (signature: string): boolean => {
  const kind = lookupFailureKind(signature)
  if (!kind) return false
  const enc = kind.staticEncodable
  return !enc.encodable && enc.reason === 'environmental'
}

/**
 * Returns true for operator-owned conditions that already raise their own
 * actionable alert and therefore must not pause all dispatch as a storm.
 *
 * `main-committer-still-dirty` is one dirty integration checkout observed by
 * several recovery tasks, not several independent task failures. The optional
 * error-class suffix is included because the failure-signature classifier
 * records this condition as `.../unclassified`.
 */
export const isSignatureStormExempt = (signature: string): boolean =>
  signature.split('/', 1)[0] === 'orchestration:main-committer-still-dirty'

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
 * The last-resort label used when nothing about a failure is known — not even
 * which step family it came from. Seeing this in the action queue means the
 * failure carried no signature and no captured output.
 */
export const GENERIC_FAILURE_LABEL = 'Mars could not determine why this task failed'

/** Older persisted fallback title, retained only so the view can replace it. */
const LEGACY_GENERIC_FAILURE_LABEL = 'A pipeline step did not complete'

/**
 * Plain-English group labels keyed by step family (the substring of the
 * failing step before the first ':'). Used when a signature has no registered
 * `FailureKind` — raw step ids must never reach an operator-facing field.
 */
const STEP_FAMILY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  verify: 'A verification check did not pass',
  setup: 'The coding environment could not be set up',
  code: 'The coder did not complete successfully',
  merge: 'The changes could not be merged',
  triage: 'The task could not be triaged',
})

/**
 * True when `title` is one of the synthesised group labels rather than copy an
 * alert-raiser wrote on purpose. The action-queue view uses this to decide
 * whether a persisted title carries real information: a purpose-built title
 * (`Plan review: 3 slices for PRD …`) must never be overwritten by derived
 * copy, but a generic label may be.
 */
export const isGenericFailureLabel = (title: string): boolean => {
  const t = title.trim()
  return (
    t === GENERIC_FAILURE_LABEL ||
    t === LEGACY_GENERIC_FAILURE_LABEL ||
    Object.values(STEP_FAMILY_LABELS).includes(t)
  )
}

/**
 * Synthesise a FailureKind for a signature that is not in the registry.
 *
 * `warmTitle` is a plain-English group label derived from the failing step's
 * family prefix — the raw step id (e.g. `verify:has-diff`, `unknown`) must NOT
 * appear in user-facing fields; it belongs in transcripts and traces only.
 * `verboseReason` opens with the first non-blank line of the captured error
 * output so the operator has an immediate hint without opening the transcript.
 */
export const unknownFailureKind = (
  failingStep: string,
  capturedError: string,
): FailureKind => {
  const errorHead = firstNonBlankLine(capturedError)

  // Map the step family to a plain-English label. Raw step ids must not appear
  // in warmTitle or verboseReason — the technical id belongs in details/traces.
  // Derive the family as the substring before the first colon so both the bare
  // form (e.g. `code`) and the qualified form (e.g. `code:coder-exit-nonzero`)
  // resolve to the same label — matching the shape of failingStepFromSignature.
  const colonIdx = failingStep.indexOf(':')
  const family = colonIdx === -1 ? failingStep : failingStep.slice(0, colonIdx)
  const groupLabel = STEP_FAMILY_LABELS[family] ?? GENERIC_FAILURE_LABEL

  return {
    signature: `${failingStep}/unknown`,
    warmTitle: groupLabel,
    verboseReason: errorHead.length > 0
      ? errorHead
      : `${groupLabel}. See the transcript for details.`,
    recipe: null,
    actions: [
      { id: 'diagnose-failure', label: 'Investigate', op: 'diagnose-failure' },
      { id: 'restart', label: 'Restart from scratch', op: 'restart' },
      { id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true },
    ],
    // Not in the registry — explicitly unclassified so the gate-enrichment
    // coverage gap stays enumerable (the runtime classifier in
    // gate-enrichment.ts applies its step-family fallback independently).
    staticEncodable: notEncodable('unclassified'),
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

/** Chars of `taskId` shown in a failed-row title (repo-wide short-id convention). */
const TITLE_TASK_ID_CHARS = 8

/** Max chars of the captured error head folded into a signature-less title. */
const TITLE_ERROR_HEAD_MAX = 98

/**
 * Compose the operator-facing action-queue title for a FAILED task.
 *
 * A queue of sixteen failures is only triageable if each row says WHICH task
 * failed and WHAT the failure was, so the title always carries every
 * discriminator that exists:
 *
 *   `<signature> — <warm reason> [task <id8>]`
 *
 * and, when no structured signature was written at failure time, degrades to
 * the next-best discriminator — the first line of the captured error:
 *
 *   `<warm reason>: <first line of the error> [task <id8>]`
 *
 * The bare warm reason (`Mars could not determine why this task failed`) is emitted ONLY
 * when there is genuinely nothing else to say: no signature, no captured
 * error, no task id. A signature with no `FAILURE_KINDS` record uses the
 * step-family's plain-English label; the action-queue detail retains the
 * technical signature as the drill-down key.
 */
export const failedTaskTitle = (args: {
  /** `tasks.failure_signature` as written at failure time, or null. */
  signature: string | null
  /** The failed task's id — rendered short. Omit/null when not task-backed. */
  taskId?: string | null
  /** Captured stderr/stdout from the failing step; used only as a fallback. */
  capturedError?: string
}): string => {
  const { signature, taskId = null, capturedError = '' } = args
  const idPart =
    taskId !== null && taskId.length > 0
      ? ` [task ${taskId.slice(0, TITLE_TASK_ID_CHARS)}]`
      : ''

  if (signature !== null && signature.length > 0) {
    const kind = lookupFailureKind(signature)
    const reason =
      kind !== null
        ? kind.warmTitle
        : unknownFailureKind(failingStepFromSignature(signature), capturedError).warmTitle
    return kind !== null ? `${signature} — ${reason}${idPart}` : `${reason}${idPart}`
  }

  const reason = unknownFailureKind('unknown', capturedError).warmTitle
  // The captured text may be a composed recovery reason
  // (`recovery_failed:<sig>: <error>`, potentially nested). Strip those
  // prefixes with the sanctioned helper so the title shows the real error
  // rather than a stack of bookkeeping prefixes.
  const head = stripRecoveryFailedPrefixes(firstNonBlankLine(capturedError))
  if (head.length === 0) return `${reason}${idPart}`
  const clipped =
    head.length > TITLE_ERROR_HEAD_MAX
      ? `${head.slice(0, TITLE_ERROR_HEAD_MAX - 1)}…`
      : head
  return `${reason}: ${clipped}${idPart}`
}
