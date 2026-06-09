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
    // verify:test/test-libsql-no-such-table fires when a test opens a libsql
    // client with an in-memory URL (`createClient({ url: ':memory:' })`),
    // creates a schema via `client.execute()`, then starts concurrent write
    // transactions with `client.transaction('write')`. The libsql sqlite3
    // backend detaches the active connection after each transaction call
    // (`this.#db = null`) and lazily creates a NEW empty in-memory SQLite
    // database on the next call — so the second concurrent transaction runs
    // against a fresh database that has no schema, producing "no such table".
    // Fix: replace the in-memory URL with a temp file-based path in the test
    // setup so all connections share the same on-disk database.
    errorClass: 'test-libsql-no-such-table',
    matchFull: /no such table:/i,
  },
  {
    // verify:test/test-libsql-not-an-error fires when a SQL migration runner
    // passes a comment-only SQL fragment to @libsql/client's `execute()`.
    // SQLite returns SQLITE_OK (code 0) when asked to prepare a statement
    // consisting entirely of `--` comments — no real statement is produced.
    // The libsql sqlite3 backend surfaces this SQLITE_OK as a LibsqlError
    // with code SQLITE_UNKNOWN_0 and message "not an error".
    //
    // Investigated 2026-05-27 (task mars-8c56c297): the Drizzle migration
    // runner in src/db/migrate.ts splits SQL files on
    // `'--> statement-breakpoint'` but does NOT filter the leading comment
    // block that precedes the first breakpoint. That comment block becomes
    // a non-empty "statement" after trim(), and executing it via
    // `c.execute(stmt)` triggers the SQLITE_OK / "not an error" error.
    // Fix: add a filter in `runMigration` that skips any fragment whose
    // every non-empty line starts with `--`.
    errorClass: 'test-libsql-not-an-error',
    matchFull: /SQLITE_UNKNOWN_0: not an error/,
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

export const computeFailureSignature = (
  failingStep: string,
  errorOutput: string,
): string => {
  const errorClass = classifyError(errorOutput)
  return `${failingStep}/${errorClass}`
}

export const isUnclassifiedSignature = (signature: string): boolean =>
  signature.endsWith(`/${UNCLASSIFIED_ERROR_CLASS}`)

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
  'verify:has-diff/worktree-missing': (taskId) =>
    `task worktree was pruned before verify could run (likely a daemon restart) — infrastructure condition; mars restart ${taskId}`,
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
