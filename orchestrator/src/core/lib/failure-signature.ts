/**
 * Failure signatures are human-readable technical keys, not hashes.
 *
 * Shape: `<failingStep>/<error-class>` — e.g. `verify:has-diff/no-commits-ahead`,
 * `merge:dirty-target/uncommitted-changes`, `setup:install-failed/lockfile-drift`.
 *
 * The signature is the unit a Recovery recipe binds to (see
 * docs/adr/0002-recipe-per-failure-signature.md). Each registered recipe
 * declares the signatures it covers; when a failure produces a signature
 * with no recipe, the orchestrator does NOT enqueue a generic recovery —
 * it raises an actionQueue item and dispatches an Investigator agent.
 *
 * `error-class` is derived by `classifyError`: for known error patterns it
 * returns a stable slug; for unknown errors it returns `unclassified` so
 * the registry lookup deterministically misses, surfacing the gap rather
 * than papering over it.
 */

/**
 * Grammar that a valid step identifier must satisfy.
 * Shape: `<segment>` or `<segment>:<segment>` (repeatable colon-separated).
 * Each segment is lower-case ASCII, digits, and hyphens; must start with a
 * letter. Spaces, capitals, and punctuation other than `-`/`:` are rejected.
 *
 * Examples that pass: `verify:has-diff`, `code:coder-exit-nonzero`,
 * `requeue:time-bound-exceeded`, `unknown`.
 *
 * Examples that fail: `Re-queue time bound exceeded: 1 attempt(s) over 270m`
 * (spaces, capitals, parentheses), `''` (empty), `verify:` (empty segment).
 */
export const STEP_ID_RE = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)*$/

/** Fallback step id used when the raw value is absent or fails the grammar. */
export const UNKNOWN_STEP_ID = 'unknown'

/**
 * Validate and return a step id, or `null` when `raw` is absent or contains
 * prose (spaces, capitals, punctuation that violates the grammar).
 *
 * @returns The trimmed value when it satisfies `STEP_ID_RE`; `null` otherwise.
 */
export const asStepId = (raw: string | null | undefined): string | null => {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  return STEP_ID_RE.test(trimmed) ? trimmed : null
}

const ANSI_PATTERN =
  // CSI sequences and a few common other escape sequences.
  // eslint-disable-next-line no-control-regex
  /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07]*\x07|\x1B[@-Z\\-_]/g

const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, '')

export const firstNonBlankLine = (text: string): string => {
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const stripped = stripAnsi(raw).trim()
    if (stripped.length > 0) return stripped
  }
  return ''
}

export const UNCLASSIFIED_ERROR_CLASS = 'unclassified'

export interface ErrorClassRule {
  /** Slug returned when the rule matches. Becomes part of the signature. */
  errorClass: string
  /**
   * Either a regex applied to the first non-blank stripped line of the
   * error output, or an exact substring match. Order matters — the first
   * matching rule wins.
   */
  match?: RegExp | string
  /**
   * Alternative to `match`: a regex or substring tested against the
   * **entire** error output, not just the first line. Use this when the
   * distinguishing signal is buried in the body (e.g. a second-line
   * `fatal:` that follows a generic `Command failed:` lead). If a rule
   * has both `match` and `matchFull`, `match` is checked first.
   */
  matchFull?: RegExp | string
}

/**
 * Closed registry of known error-class rules. Add an entry here when you
 * add a new recovery recipe that covers a previously-unclassified error.
 *
 * Each rule's `errorClass` must be a stable slug (kebab-case, no spaces).
 * The Investigator agent proposes additions to this list when it sees an
 * unclassified error worth recovering automatically.
 *
 * ## Intentionally unclassified failure steps
 *
 * `verify:test` failures produce `verify:test/unclassified` and route to
 * the actionQueue/Investigator pattern **by design** — no rule is registered here
 * for them. Each test failure has a unique root cause (wrong assertion,
 * null deref, API mismatch, logic error, newly introduced test bug, etc.)
 * and a single mechanical recipe cannot give correct guidance across all
 * occurrences. Investigated: 2026-05-18 (actionQueue item 7eaf941e, task
 * mars-eaad74d8); confirmed that the right resolution is a targeted
 * follow-up task rather than a generic recipe entry.
 *
 * `verify:typecheck` failures that produce a V8/Node.js native crash dump
 * (C++ stack trace, no TypeScript error code) also remain unclassified by
 * design. The crash is an OS-level runtime event — OOM, Node.js bug, or
 * transient system pressure — not a code defect a recipe can fix. These
 * are environmental failures; the correct resolution is operator triage.
 * Investigated: 2026-05-30 (inbox item ab6a5e3f, task mars-e4a7152f);
 * confirmed non-reproducible (branch and orchestrator dir absent from
 * worktree), deliverable already on main, no recipe warranted.
 */
export const errorClassRules: readonly ErrorClassRule[] = [
  {
    // A headless provider adapter refused to spawn its CLI because the
    // composed prompt was blank. Every provider CLI here takes the prompt as
    // an argv value and silently falls back to reading stdin when it is
    // missing; dispatched workers get stdin=/dev/null, so the CLI exits
    // non-zero having produced no diagnostic at all. The adapters short-
    // circuit that (see EMPTY_PROMPT_REFUSAL in lib/git/claude.ts) and this
    // rule keeps the resulting signature named rather than `unclassified`.
    // Operator condition, not a code defect: the prompt-composition path
    // upstream of dispatch is what needs fixing.
    errorClass: 'empty-prompt',
    match: /refusing to spawn \S+ with an empty prompt/i,
    matchFull: /refusing to spawn \S+ with an empty prompt/i,
  },
  {
    // A provider rejected the run on rate/spend limits. The code step
    // normally intercepts this earlier via RunClaudeResult.quotaRejected and
    // re-queues without ever failing the task, so reaching classification at
    // all means the sentinel was missed — name it anyway so the gap is
    // visible instead of being buried in `unclassified`.
    errorClass: 'provider-quota',
    match: /hit your usage limit|usage limit reached|rate\/usage limit/i,
    matchFull: /hit your usage limit|usage limit reached|rate\/usage limit/i,
  },
  {
    // Behaviour verification (the behaviour-verify step) reached the live
    // surface and found at least one Definition-of-Done criterion observably
    // contradicted, with screenshot evidence. The step emits this exact
    // first line in its error output; the resulting signature
    // `behaviour-verify:dod-unmet/dod-unmet` binds to the registered
    // recovery recipe in fix-recipes.ts (ADR-0002 — registered in the same
    // change that added the step).
    errorClass: 'dod-unmet',
    match: /definition-of-done criteri(?:on|a) unmet on live surface/i,
  },
  {
    errorClass: 'no-commits-ahead',
    match: /no commits ahead of integration branch/i,
  },
  {
    // verify:has-diff fires this when the git spawn's working directory is
    // absent — the worktree was pruned (e.g. daemon restart / recover sweep)
    // while the task was still in flight. Distinguishable from a genuine
    // empty-diff because the error output contains "worktree path … no longer
    // exists" rather than the commit-count check output. The first non-blank
    // line of the output produced by captureHasDiff starts with this phrase.
    errorClass: 'worktree-missing',
    match: /worktree path .+ no longer exists/i,
  },
  {
    // assertWorktreeHygieneForVerify fires this when the worktree has a
    // different branch checked out than the task branch recorded in the DB.
    // Infrastructure condition — task can be restarted.
    errorClass: 'branch-drift',
    match: /verify hygiene: worktree on wrong branch, expected/i,
  },
  {
    // assertWorktreeHygieneForVerify fires this when a .git/rebase-merge or
    // .git/rebase-apply state directory is still present in the worktree from
    // a previous interrupted rebase. Infrastructure condition — restart.
    errorClass: 'stale-rebase-state',
    match: /verify hygiene: stale rebase state present at/i,
  },
  {
    errorClass: 'uncommitted-changes',
    // Matches both legacy wording (`merge target ... has uncommitted changes`)
    // and the new fast-forward-feasibility wording emitted by
    // checkMergeTargetStatus when a tracked-file change overlaps the ff path
    // set. Folded into one slug so retry recipes don't fork.
    match: /has uncommitted changes|tracked changes on paths the fast-forward would update/i,
  },
  {
    errorClass: 'not-fast-forward',
    // Covers three distinct first-line patterns that all mean "integration
    // advanced after the task branch was last rebased; the code is committed
    // on the branch, just re-land it":
    //
    //  (a) Pre-flight divergence: emitted before the VCS supervisor runs when
    //      the task branch has already diverged from integration.
    //        "task branch task/x is not a fast-forward of main"
    //
    //  (b) Post-supervisor ancestry check (mergeBranch Path 2): after the VCS
    //      supervisor completes a rebase, git.ts verifies the fast-forward via
    //      `merge-base --is-ancestor`. If integration advanced in the window
    //      between the supervisor finishing and this check, it returns aborted=true
    //      with first-line:
    //        "fast-forward into <branch> not possible: <sha> is not an ancestor of <sha>."
    //
    //  (c) CAS race on update-ref (mergeBranch Path 3): the ancestry check
    //      passes but integration advances before `git update-ref <ref> <new>
    //      <old>` executes. mergeBranch returns aborted=true with first-line:
    //        "integration moved during merge, retry needed: <branch> advanced concurrently."
    //
    // Also covers the `git merge --ff-only` fatal that surfaces when main
    // advances AFTER the VCS supervisor rebases but BEFORE the fast-forward
    // completes — a race condition where the distinguishing signal appears in
    // the body rather than the first line (hence the matchFull guard too).
    match: /is not a fast-forward of|is not an ancestor of|integration moved during merge/i,
    matchFull: /Not possible to fast-forward/i,
  },
  {
    // Signal-killed install (no manifest fault). Covers:
    //   - SIGKILL from the wall-clock timeout (exit 137) or an explicit SIGKILL
    //     surfaced in the error text;
    //   - SIGINT abort (exit 130, e.g. parent daemon restart, Ctrl-C);
    //   - pnpm-style abort (exit 254 — pnpm raises this when a lifecycle script
    //     is aborted or a child is killed; the stderr is typically empty).
    // Must be checked before install-frozen-lockfile because the install error
    // text embeds the install command (which contains "frozen-lockfile") — without
    // this guard, a signal-killed install would be misclassified as a lockfile-drift
    // failure and the recovery agent would chase a non-existent manifest issue.
    // Match both error-string formats: WorktreeInstallError's "exited with N" and
    // the workspace-dep install path's bare "exited N".
    errorClass: 'install-timeout',
    match: /exited (?:with )?(?:137|130|254)\b|SIGKILL|SIGINT|exit code (?:137|130|254)\b/i,
  },
  {
    errorClass: 'install-frozen-lockfile',
    match: /frozen-lockfile/i,
  },
  {
    errorClass: 'install-missing-peer',
    match: /requires a peer of/i,
  },
  {
    // TS2339: Property 'X' does not exist on type 'Y'.
    // Fired when a task removes a field from a type definition (e.g. drops
    // `removedField` from `SomeType`) but leaves behind call sites that
    // still access that field. A recovery agent can inspect the original task
    // prompt to determine whether the intent was deletion (complete the
    // deletion at all call sites) or addition (add the missing field).
    // TS2353 ("Object literal may only specify known properties, and 'X' does
    // not exist in type 'Y'") fires for the same root cause when the removed
    // field appears inside an object literal rather than as a property access.
    // Both codes share this slug — fix strategy is identical. `match` fires
    // when TS2339 appears on the first error line (the common case); the
    // `matchFull` guard catches the rare case where only TS2353 errors appear
    // (e.g. all property accesses were cleaned up but object literals were not).
    errorClass: 'typecheck-property-not-exist',
    match: /\bTS2339:/,
    matchFull: /\bTS2353:/,
  },
  {
    errorClass: 'typecheck-cannot-find-name',
    match: /\bTS2304:/,
  },
  {
    errorClass: 'typecheck-cannot-find-module',
    match: /\bTS2307:/,
  },
  {
    errorClass: 'typecheck-type-mismatch',
    match: /\bTS2322:/,
  },
  {
    // TS2345: Argument of type X is not assignable to parameter of type Y.
    // Most commonly surfaces in test code that passes a Promise resolver
    // directly as an error-first callback (e.g. `server.close(resolve)`),
    // where the callback expects `(err?: Error) => void` but the resolver
    // is typed `(value: void | PromiseLike<void>) => void`. Fix: wrap the
    // callback — `(resolve, reject) => server.close((err) => err ? reject(err) : resolve())`.
    // Also covers any other argument type mismatch the coding agent introduced.
    errorClass: 'typecheck-arg-type-mismatch',
    match: /\bTS2345:/,
  },
  {
    // TS2353: Object literal may only specify known properties, and 'X'
    // does not exist in type 'Y'. Fires when a object literal in test or
    // source code includes a field that was removed from the type in the
    // same task (TypeScript's excess-property check). The canonical cause
    // is a partial type cleanup: the implementation updated the type to drop
    // a field (e.g. `removedField`) but the object literal(s) that create
    // instances of that type were not updated. Fix: remove the excess
    // property from the object literal — do NOT revert the type change.
    errorClass: 'typecheck-excess-property',
    match: /\bTS2353:/,
  },
  {
    // TS2694: Namespace '...' has no exported member '...'.
    // Fired when a test or source file imports a named export that does not
    // exist in the target module. The canonical cause is TDD work where
    // tests were written before the implementation was added, or where a
    // function was renamed in the implementation but not in the import.
    // A recovery agent can inspect the test file's usage to infer the
    // missing signature and add the implementation.
    errorClass: 'typecheck-missing-export',
    match: /\bTS2694:/,
  },
  {
    errorClass: 'merge-conflict-unresolved',
    match: /CONFLICT|fix conflicts/i,
  },
  {
    // merge:vcs-supervisor-aborted/rebase-no-in-progress-state fires when
    // mergeBranch's guard detects that git rebase exited non-zero WITHOUT
    // leaving a rebase-merge/ or rebase-apply/ state directory on disk.
    // This means git aborted the rebase before it could conflict (e.g.
    // uncommitted changes in the worktree blocked the rebase, an invalid
    // upstream ref, or an empty-commit stop). mergeBranch returns aborted=true
    // with this specific first-line rather than dispatching Vega with a
    // false-premise "rebase is in progress" prompt.
    errorClass: 'rebase-no-in-progress-state',
    match: /rebase produced no in-progress state/i,
  },
  {
    // merge:vcs-supervisor-aborted/rebase-dirty-worktree fires when the
    // pre-rebase hygiene check in mergeBranch detects that the task worktree
    // has uncommitted or untracked files BEFORE git rebase runs. mergeBranch
    // returns aborted:true with this sentinel as its first line so the failure
    // routes to the named slug rather than /unclassified or
    // /rebase-no-in-progress-state. The correct resolution is to restart the
    // task (re-provisions the worktree from scratch), not to spawn a code-fix
    // recovery.
    //
    // matchFull, not match: the merge primitive prefixes the sentinel with
    // "merge aborted by vcs-supervisor; worktree retained at <path>", and the
    // durable recovery-spawn path re-classifies from that stored `error`. Under
    // first-line-only matching the sentinel was invisible there and the failure
    // degraded to `merge/unclassified` (task fix-30ac0aaa) — a generic bucket
    // that also feeds the signature-storm circuit breaker. Matching the whole
    // body keeps the named slug reachable from every call site.
    errorClass: 'rebase-dirty-worktree',
    matchFull: /worktree dirty before rebase/i,
  },
  {
    // The provider CLI itself could not be executed: `spawn` failed with
    // ENOENT/EACCES, or the shell reported exit 127 ("command not found").
    // `runSubprocessStreaming` surfaces the spawn failure as
    // `spawn <cmd> ENOENT: …` on stderr with exit code 127.
    //
    // Whatever produces it — an unresolvable binary, a malformed argv, a
    // mid-session uninstall — the step dies in milliseconds having done no
    // work, and without this rule every occurrence lands in the contentless
    // `coder-exit-nonzero` / unclassified bucket. Naming the class is the
    // point: "the command could not be executed" is a completely different
    // diagnosis from "the coder ran and failed".
    //
    // `checkProviderBin` (workers/provider-bin.ts) refuses to start the daemon
    // when the configured provider's binary cannot be resolved at boot; this
    // rule covers everything that still reaches a spawn failure afterwards.
    //
    // Deliberately narrow — an explicit spawn-failure marker or an exit code
    // of exactly 127 in the orchestrator's own wording. A bare "command not
    // found" is NOT matched: coder stderr routinely quotes shell output from
    // commands the agent itself ran, and misfiling those would be worse than
    // leaving them unclassified.
    errorClass: 'provider-binary-missing',
    matchFull:
      /\bspawn\s+\S+\s+(?:ENOENT|EACCES)\b|\bcoder exited 127\b|\bexited with (?:code )?127\b/i,
  },
  {
    // The commit gate could not write into the repo's shared git metadata
    // directory. The canonical shape is:
    //
    //   Git cannot create '.git/worktrees/<id>/index.lock': Operation not permitted
    //
    // This is NOT lock contention (see index-lock-contention below, which is
    // "File exists"): the write itself is denied. It happens when the daemon
    // was started from a shell whose sandbox permits writes to worktree files
    // under `.mars/worktrees/<id>/` but denies writes to
    // `<repo>/.git/worktrees/<id>/` — a different filesystem location. Every
    // coder then edits files and runs tests fine and fails only at commit
    // time. Observed 79 times in a single incident, all of it landing in the
    // generic `code/unclassified` bucket, which poisoned that bucket and
    // tripped the signature storm breaker.
    //
    // MUST be checked before index-lock-contention so an EPERM on index.lock
    // is never mistaken for a transient stale-lock condition (the operator
    // remedies are completely different: restart the daemon from a shell with
    // write access vs. clear a stale lock and retry).
    //
    // Intentionally has NO recovery recipe: no amount of code editing fixes a
    // sandbox denial. `checkGitMetadataWritable` (git-metadata-preflight.ts)
    // now refuses to start the daemon in this state; this rule exists so any
    // occurrence that slips past the pre-flight is diagnosable on sight.
    errorClass: 'git-metadata-denied',
    matchFull:
      /(?:index\.lock|\.git\/worktrees\/)[^\n]*(?:Operation not permitted|EPERM|Permission denied)|(?:Operation not permitted|EPERM|Permission denied)[^\n]*(?:index\.lock|\.git\/worktrees\/)/i,
  },
  {
    // merge:crashed when git cannot acquire the index lock because another
    // git process is running (or crashed and left a stale .git/index.lock).
    // The distinguishing signal is on the second line of the error, not the
    // first (`Command failed: git checkout <branch>` leads), so matchFull
    // is required. Intentionally has NO registered recovery recipe — this is
    // a transient environmental failure; the task's coding work is already
    // committed on its branch. Operator fix: confirm no active git process
    // holds the lock, then `mars restart <task-id>`.
    errorClass: 'index-lock-contention',
    matchFull: /index\.lock.*File exists/i,
  },
  {
    // verify:test/test-assertion-error fires when the test runner (vitest)
    // reports an AssertionError — the implementation does not match what the
    // tests expect. Common causes: wrong string literal, missing process.exit
    // call, or a missing/incorrect side-effect (file create/remove). A recovery
    // agent can read the assertion error output to identify the exact mismatch
    // and fix the implementation without touching the test files.
    errorClass: 'test-assertion-error',
    matchFull: /AssertionError:/,
  },
  {
    // verify:test/test-no-suite-found fires when vitest discovers a test file
    // (matching its include glob) that contains no describe/it/test blocks —
    // vitest exits non-zero with "No test suite found in file <path>".
    // The canonical cause is a coding agent that left a comment-only placeholder
    // file behind instead of deleting it (the real tests were written elsewhere
    // in the same directory). Fix: read the empty file, check for sibling test
    // files covering the same module, then delete the placeholder. If no sibling
    // tests exist, populate the file with a minimal test suite instead.
    errorClass: 'test-no-suite-found',
    matchFull: /No test suite found in file/,
  },
  {
    // verify:test/test-pg-undefined-table fires when a test hits PostgreSQL
    // error 42P01 (undefined_table, "relation ... does not exist"). The
    // canonical cause is a test fixture that queries a table before applying
    // the canonical schema (pg-schema.ts `ensureSchema`) to its per-test
    // database — the schema-lifecycle successor to the SQLite-era "no such
    // table" class. Fix: run ensureSchema (or the fixture's setup path) on
    // the test's database before the first query.
    errorClass: 'test-pg-undefined-table',
    matchFull: /42P01|relation "[^"]+" does not exist/,
  },
  {
    // code:coder-exit-nonzero/api-unreachable fires when the claude CLI dies
    // because the Claude API was unreachable — network partition, DNS failure,
    // or a transient outage. The CLI exits non-zero and emits text like:
    //   "API Error: Unable to connect to API (ConnectionRefused)"
    // Nothing was wrong with the code; the task should be re-queued, not
    // sent to a recovery fixer that would fail for the same reason.
    // Must come BEFORE test-pg-connection-refused so the API-level signal
    // "Unable to connect to API" is claimed before the broader ECONNREFUSED
    // matchFull picks it up as a test-PG failure.
    errorClass: 'api-unreachable',
    matchFull: /Unable to connect to API|API Error[^:]*:.*(?:ConnectionRefused|ECONNREFUSED)/i,
  },
  {
    // verify:test/test-pg-connection-refused fires when a test cannot reach
    // the PostgreSQL server: 57P03 (cannot_connect_now — server starting up
    // or shutting down) or a plain TCP ECONNREFUSED (server absent, stale
    // DSN in .mars/pg.dsn, or the daemon that provisions the embedded
    // server is not running). Environmental, not a code defect — the fix is
    // to start/restart the daemon or repair the DSN, not to edit code.
    errorClass: 'test-pg-connection-refused',
    matchFull: /57P03|ECONNREFUSED/,
  },
  {
    // verify:test/test-pg-deadlock fires on PostgreSQL 40P01 (deadlock
    // detected): two concurrent transactions acquired row locks in opposite
    // orders. Under MVCC this replaces the SQLite-era single-writer
    // SQLITE_BUSY contention class. Fix: order writes consistently or
    // serialize the conflicting transactions in the test.
    errorClass: 'test-pg-deadlock',
    matchFull: /40P01|deadlock detected/,
  },
]

export const classifyError = (errorOutput: string): string => {
  const head = firstNonBlankLine(errorOutput)
  if (head.length === 0) return UNCLASSIFIED_ERROR_CLASS
  for (const rule of errorClassRules) {
    if (rule.match !== undefined) {
      const matched =
        typeof rule.match === 'string'
          ? head.includes(rule.match)
          : rule.match.test(head)
      if (matched) return rule.errorClass
    }
    if (rule.matchFull !== undefined) {
      const matched =
        typeof rule.matchFull === 'string'
          ? errorOutput.includes(rule.matchFull)
          : rule.matchFull.test(errorOutput)
      if (matched) return rule.errorClass
    }
  }
  return UNCLASSIFIED_ERROR_CLASS
}

/**
 * The one prefix a recovery-task escalation stamps onto `failure_reason` /
 * `error`. Composed form:
 *
 *   `recovery_failed:<failureSignature>: <truncated error>`
 *
 * The signature half never contains whitespace, so `': '` is an unambiguous
 * separator between the prefix and the error tail — that is what makes
 * {@link stripRecoveryFailedPrefixes} exact rather than heuristic.
 */
export const RECOVERY_FAILED_PREFIX = 'recovery_failed:'

/** `recovery_exhausted:<sig>` — the code-recovery budget gate in `queue-fix-tasks.ts`. */
export const RECOVERY_EXHAUSTED_PREFIX = 'recovery_exhausted:'

/** `recovery_disabled:<sig>: <err>` — the `MARS_RECOVERY_DISABLED=1` kill switch. */
export const RECOVERY_DISABLED_PREFIX = 'recovery_disabled:'

/** `non-code-retry-exhausted:<sig>` — the non-code re-queue cap. */
export const NON_CODE_RETRY_EXHAUSTED_PREFIX = 'non-code-retry-exhausted:'

/** `signature-storm:<sig>` — the signature-storm circuit breaker's first trip. */
export const SIGNATURE_STORM_PREFIX = 'signature-storm:'

/** `spend_control_suppressed:<reason>` — the dispatch spend controller's suppression. */
export const SPEND_CONTROL_SUPPRESSED_PREFIX = 'spend_control_suppressed:'

/**
 * `origin_recovery_failed:<recoveryTaskId>` — an ORIGIN failed because its own
 * (leaf, one-shot) recovery Chore died. ADR-0040 / CLAUDE.md § Blockers.
 *
 * Lives here rather than next to its composer in `blocker-resolution.ts` so the
 * vocabulary below stays a single list; `blocker-resolution.ts` imports it.
 */
export const ORIGIN_RECOVERY_FAILED_PREFIX = 'origin_recovery_failed:'

/**
 * THE COMPLETE VOCABULARY of `failure_reason` prefixes the orchestrator writes
 * for ITSELF — a terminal verdict it reached about a row, as opposed to
 * captured evidence from the failing command.
 *
 * ## Why this list is one list
 *
 * Every entry marks a row on which the orchestrator's automated options are
 * SPENT: the budget is gone, the cap is hit, the kill switch is on, the gate is
 * recovery slot is consumed. Re-driving such a row through the
 * failure handler deterministically reproduces the same verdict, which rewrites
 * `status='failed'`, which emits a fresh `task.failed`, which the next
 * recovery-spawner drain feeds straight back in — a self-feeding 30 s loop.
 * That loop has now been observed TWICE in production, both times because a
 * guard hardcoded a SUBSET of these prefixes and the writers grew a new one:
 *
 *  - a guard testing `startsWith('recovery_failed:')` against a variable that
 *    never carried the prefix (inert guard, terminal rows re-driven forever);
 *  - `isOriginRecoveryFailedReason` in `recovery-spawn.ts` recognising only
 *    `origin_recovery_failed:` while the budget gate wrote `recovery_exhausted:`
 *    (task mars-76fef59f: 314 action-queue rows in one hour).
 *
 * So: ONE list, and every consumer derives from it. Do not write a second
 * literal prefix anywhere — add it here and the guards, the signature
 * short-circuit and the Steward's status-echo scrubber all learn it at once.
 *
 * Invariant for new entries: a prefix belongs here **only** if a row carrying
 * it must never be reopened automatically. A reason that merely describes a
 * failure (a step id such as `requeue:time-bound-exceeded`, or prose) does NOT
 * belong — those rows are still owed their one recovery attempt (ADR-0040).
 */
export const TERMINAL_VERDICT_PREFIXES = [
  RECOVERY_FAILED_PREFIX,
  RECOVERY_EXHAUSTED_PREFIX,
  RECOVERY_DISABLED_PREFIX,
  NON_CODE_RETRY_EXHAUSTED_PREFIX,
  SIGNATURE_STORM_PREFIX,
  SPEND_CONTROL_SUPPRESSED_PREFIX,
  ORIGIN_RECOVERY_FAILED_PREFIX,
] as const

const escapeForRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

const TERMINAL_VERDICT_ALTERNATION = TERMINAL_VERDICT_PREFIXES.map((p) =>
  escapeForRegex(p.slice(0, -1)),
).join('|')

/**
 * Anchored pattern matching one leading terminal-verdict prefix. Used by
 * {@link computeFailureSignature} to short-circuit re-classification of a
 * reason string that already embeds a signature.
 */
const TERMINAL_VERDICT_PREFIX_RE = new RegExp(`^(?:${TERMINAL_VERDICT_ALTERNATION}):`)

/**
 * Global pattern matching every terminal-verdict token AND its argument, for
 * scrubbing derived status text out of an excerpt before it is shown to a
 * human or an agent. Consumed by the Steward's storm-excerpt assessor.
 */
export const terminalVerdictEchoPattern = (): RegExp =>
  new RegExp(`(?:${TERMINAL_VERDICT_ALTERNATION}):[^\\s]*\\s*`, 'g')

/**
 * True when `reason` is a terminal verdict the orchestrator wrote about this
 * row — i.e. its automated recovery options are already spent.
 *
 * This is THE terminality predicate. Anything that decides "may this row be
 * re-driven / reopened automatically?" must call it rather than testing a
 * prefix literal, because a literal is only ever correct until the next writer
 * is added.
 *
 * It deliberately does NOT match a plain failing-step reason (`verify:test`,
 * `code:commit-contract`) or prose, so a row's FIRST, legitimate recovery
 * attempt still goes ahead — exactly one per origin failure, per ADR-0040.
 */
export const isTerminalVerdictReason = (
  reason: string | null | undefined,
): reason is string =>
  typeof reason === 'string' &&
  TERMINAL_VERDICT_PREFIXES.some((prefix) => reason.startsWith(prefix))

/**
 * True when `reason` is already a composed recovery-failure reason.
 *
 * NARROWER than {@link isTerminalVerdictReason} and deliberately so: this one
 * answers "was this string produced by {@link composeRecoveryFailureReason}?",
 * which is what the compose/strip pair needs. For "is this row spent?" use
 * {@link isTerminalVerdictReason}.
 */
export const isRecoveryFailedReason = (
  reason: string | null | undefined,
): reason is string =>
  typeof reason === 'string' && reason.startsWith(RECOVERY_FAILED_PREFIX)

/**
 * Remove every leading `recovery_failed:<signature>: ` segment, returning the
 * bare error text underneath.
 *
 * Needed because the composed reason is written to BOTH `failure_reason` and
 * `error`, and `error` is what the `task.failed` outbox event carries — so any
 * path that re-enters the failure handler with a previously composed reason
 * would otherwise prepend a second prefix, then a third, … Each pass also
 * truncates the tail to 500 chars, so the nesting silently eats the real error
 * instead of growing the string (observed: `failure_reason` pinned at ~542
 * chars, ten prefixes deep, original error gone).
 */
export const stripRecoveryFailedPrefixes = (reason: string): string => {
  let out = reason
  while (out.startsWith(RECOVERY_FAILED_PREFIX)) {
    const sep = out.indexOf(': ', RECOVERY_FAILED_PREFIX.length)
    if (sep === -1) break
    out = out.slice(sep + 2)
  }
  return out
}

/**
 * Compose the single, never-nested recovery-failure reason for a recovery task.
 *
 * Idempotent by construction:
 * `compose(sig, compose(sig, e)) === compose(sig, e)` — any prefixes already
 * present on `errorText` are stripped before the one prefix is applied.
 */
export const composeRecoveryFailureReason = (
  failureSignature: string,
  errorText: string,
  maxErrorChars = 500,
): string =>
  `${RECOVERY_FAILED_PREFIX}${failureSignature}: ${stripRecoveryFailedPrefixes(
    errorText,
  ).slice(0, maxErrorChars)}`

/**
 * Returns the `<failingStep>/<errorClass>` failure signature.
 *
 * Idempotent: if `errorOutput` is already a composed reason string that
 * embeds this signature (e.g. `recovery_exhausted:verify:typecheck/typecheck-cannot-find-name: …`),
 * the function extracts the existing error class rather than re-running
 * `classifyError`, which would match nothing and clobber the correct class
 * with `unclassified`.
 *
 * Invariant: `computeFailureSignature(step, computeFailureSignature(step, x))`
 * equals `computeFailureSignature(step, x)` for all inputs.
 *
 * Invariant: the step half of the returned signature always satisfies
 * `STEP_ID_RE`. If `rawFailingStep` is prose (spaces, capitals, punctuation)
 * it is normalised to `UNKNOWN_STEP_ID` so the caller cannot mint a
 * prose-contaminated signature.
 */
export const computeFailureSignature = (
  rawFailingStep: string,
  errorOutput: string,
): string => {
  // `runVerifyStep` adds this marker when a child exits by SIGTERM or
  // SIGKILL. It must override the command's nominal gate name: a SIGTERM
  // during `typecheck` is an infrastructure kill, not a type error.
  const kill = firstNonBlankLine(errorOutput).match(
    /^verify child killed by SIG(TERM|KILL) \(exit 1(?:43|37)\)$/i,
  )
  if (kill !== null) {
    return `verify:killed/sig${kill[1]!.toLowerCase()}`
  }

  // Normalise the step id. Prose values (e.g. "Re-queue time bound exceeded:
  // 1 attempt(s) over 270m …") fail the grammar and are replaced with
  // UNKNOWN_STEP_ID so no prose can reach the signature.
  const failingStep = asStepId(rawFailingStep) ?? UNKNOWN_STEP_ID

  // When `errorOutput` is a composed reason string, its first line looks like:
  //   recovery_exhausted:verify:typecheck/typecheck-cannot-find-name: <truncated error>
  //   recovery_failed:verify:typecheck/typecheck-cannot-find-name: <truncated error>
  // Feeding that string through classifyError matches no raw-output rule,
  // returning 'unclassified' and clobbering the original class.
  // Detect this by stripping the known prefix and checking whether what
  // remains starts with `<failingStep>/` — if so, extract the embedded class.
  const firstLine = firstNonBlankLine(errorOutput)
  const withoutPrefix = firstLine.replace(TERMINAL_VERDICT_PREFIX_RE, '')
  const signaturePrefix = `${failingStep}/`
  if (withoutPrefix.startsWith(signaturePrefix)) {
    const tail = withoutPrefix.slice(signaturePrefix.length)
    const m = tail.match(/^([a-z][a-z0-9-]*)/)
    if (m !== null) return `${failingStep}/${m[1]}`
  }
  const errorClass = classifyError(errorOutput)
  return `${failingStep}/${errorClass}`
}

export const isUnclassifiedSignature = (signature: string): boolean =>
  signature.endsWith(`/${UNCLASSIFIED_ERROR_CLASS}`)

/**
 * The FAMILY of a failure signature: `<gate>/<errorClass>` — the signature with
 * every KIND segment of the failing step dropped.
 *
 *   `code:commit-contract/uncommitted-changes` → `code/uncommitted-changes`
 *   `code/uncommitted-changes`                 → `code/uncommitted-changes`
 *   `verify:has-diff/no-commits-ahead`         → `verify/no-commits-ahead`
 *   `daemon-killed`                            → `daemon-killed/`
 *
 * ## Why this exists
 *
 * One failure reaches `computeFailureSignature` from two call sites with two
 * step granularities, and both are legitimate:
 *
 *  - the INLINE path passes the fine step the primitive knows it is in
 *    (`code:commit-contract`), which is also what gets stamped on the task's
 *    `failure_signature` column;
 *  - the DURABLE recovery-spawn subscriber recovers the step from the DB
 *    (`asStepId(failure_reason) ?? asStepId(failed_phase)`). `failure_reason`
 *    often holds a whole signature or a `recovery_failed:` reason — neither
 *    satisfies `STEP_ID_RE` — so it falls back to the coarse `failed_phase`
 *    (`code`) and mints `code/uncommitted-changes` for the identical failure.
 *
 * The two forms name the SAME failure. Anything that has to recognise "these
 * are the same failure" — the signature-storm streak counter and the storm
 * evidence lookup that briefs the Steward — must compare families, not exact
 * strings, or the streak trips on one form while the evidence query looks for
 * the other and finds nothing (observed live: a Steward dispatched blind with
 * ~2.2 KB of real failure output sitting unread in the DB).
 *
 * The kind segment is what is dropped, never the error class: the class is the
 * part every producer agrees on, while the step half is exactly the part that
 * degrades. Widening is therefore bounded to "same gate, same error class".
 */
export const failureSignatureFamily = (signature: string): string => {
  const slash = signature.indexOf('/')
  const step = slash === -1 ? signature : signature.slice(0, slash)
  const errorClass = slash === -1 ? '' : signature.slice(slash + 1).split('/')[0] ?? ''
  const colon = step.indexOf(':')
  const gate = colon === -1 ? step : step.slice(0, colon)
  return `${gate}/${errorClass}`
}

/** True when two signatures name the same failure at different step granularities. */
export const isSameFailureFamily = (a: string, b: string): boolean =>
  failureSignatureFamily(a) === failureSignatureFamily(b)

/**
 * SQL twin of {@link failureSignatureFamily}: an expression that computes the
 * family of a signature COLUMN, so a query can select every row in the family
 * without pulling the whole `tasks` table into JS.
 *
 * Kept adjacent to the TS implementation on purpose — the two must agree, and
 * `__tests__/failure-signature-family.test.ts` asserts that they do over a corpus
 * of signatures, so a change to one that is not mirrored in the other fails.
 *
 * `column` is interpolated verbatim: pass a literal column name from this
 * codebase, NEVER user input.
 */
export const failureSignatureFamilySql = (column: string): string =>
  `(split_part(split_part(${column}, '/', 1), ':', 1) || '/' || split_part(${column}, '/', 2))`

/**
 * Operator-facing cause sentences keyed by the full `<failingStep>/<error-class>`
 * signature. Each entry renders a one-line plain-English sentence that names
 * who owns the next action (operator vs agent) so triage doesn't have to parse
 * the slug.
 *
 * Keying by full signature (not by error-class alone) lets the same error class
 * fired from different steps carry different sentences when the action differs.
 *
 * IMPORTANT: missing entries return `null` — the renderer omits the line
 * entirely rather than emitting a confusing 'unknown' placeholder.
 *
 * Add a new entry HERE in the same file as the signature's error-class rule
 * so a contributor wiring a new signature can attach its sentence without
 * hunting through render code.
 */
type CauseRenderer = (taskId: string) => string

const causeSentencesBySignature: Readonly<Record<string, CauseRenderer>> = {
  // Operator-owned: merge target had uncommitted changes when the merge-time pre-flight ran.
  'merge:preflight/uncommitted-changes': (taskId) =>
    `integration branch has uncommitted changes — clean it, then mars restart ${taskId}`,
  // Agent-owned: the coder ran but produced no commits on the task branch.
  'verify:has-diff/no-commits-ahead': () =>
    `task branch has no commits ahead of integration — the agent didn't commit; needs a new task or restart`,
  // Infrastructure-owned: the worktree was pruned before verify could inspect it.
  'verify:worktree-hygiene/worktree-missing': (taskId) =>
    `task worktree was pruned before verify could run (likely a daemon restart) — infrastructure condition; mars restart ${taskId}`,
  // Agent-owned: the behaviour-verify step observed a Definition-of-Done
  // criterion contradicted on the live surface; a recovery Chore was spawned.
  'behaviour-verify:dod-unmet/dod-unmet': () =>
    `behaviour verification contradicted a Definition-of-Done criterion on the live surface — the recovery Chore closes the gap on the origin worktree`,
  // Environmental: Claude's API was unreachable — nothing wrong with the code.
  'code:coder-exit-nonzero/api-unreachable': (taskId) =>
    `the coder couldn't reach Claude's API — nothing was wrong with the code. Retry once connectivity is back: mars restart ${taskId}`,
  // Operator-owned: the daemon could not execute the provider CLI at all.
  'code:coder-exit-nonzero/provider-binary-missing': (taskId) =>
    `the command the daemon spawned for the coder could not be executed (spawn failure / exit 127) — the step did no work. Check that the provider binary resolves in the daemon's environment (or pin MARS_<PROVIDER>_BIN to an absolute path), then mars restart ${taskId}`,
  // Operator-owned: the daemon cannot write the repo's shared git metadata.
  'code:coder-exit-nonzero/git-metadata-denied': (taskId) =>
    `the daemon cannot write into <repo>/.git/worktrees — every coder will fail at the commit gate. Restart the daemon from a shell with write access to that directory, then mars restart ${taskId}`,
}

/**
 * Render a human-readable cause sentence for a failure signature, or `null`
 * when no sentence is registered. Callers should omit the line entirely on
 * `null` — never substitute a placeholder.
 */
export const causeForSignature = (
  signature: string,
  taskId: string,
): string | null => {
  const renderer = causeSentencesBySignature[signature]
  return renderer ? renderer(taskId) : null
}
