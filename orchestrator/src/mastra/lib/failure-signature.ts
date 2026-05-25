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
 * it raises an inbox item and dispatches an Investigator agent.
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
 */
export const errorClassRules: readonly ErrorClassRule[] = [
  {
    errorClass: 'no-commits-ahead',
    match: /no commits ahead of integration branch/i,
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
    // setup:preflight/dirty-main fires when the setup-worktree pre-flight
    // finds the merge target dirty BEFORE any worktree is created or coder
    // dispatched (DIRTY_MAIN_SETUP_MESSAGE in implement-workflow.ts). Kept
    // distinct from `uncommitted-changes` (which is the merge-time variant)
    // so the recovery recipe can operate on the merge target directly rather
    // than on a failing task branch. The phrasing deliberately avoids the
    // substring "has uncommitted changes" so it does not collide with the
    // rule above.
    errorClass: 'dirty-main',
    match: /merge target is dirty before coding/i,
  },
  {
    errorClass: 'not-fast-forward',
    // Matches the pre-flight message emitted when the task branch has diverged
    // from integration before the VCS supervisor even runs (first-line match).
    // Also matches the `git merge --ff-only` fatal that surfaces when main
    // advances AFTER the VCS supervisor rebases but BEFORE the fast-forward
    // completes — a race condition where the distinguishing signal appears in
    // the body rather than the first line (hence the matchFull guard too).
    match: /is not a fast-forward of/i,
    matchFull: /Not possible to fast-forward/i,
  },
  {
    // SIGKILL from the wall-clock timeout (exit 137) or an explicit SIGKILL
    // surfaced in the error text. Must be checked before install-frozen-lockfile
    // because WorktreeInstallError embeds the install command (which contains
    // "frozen-lockfile") in its first line — without this guard, a timed-out
    // install would be misclassified as a lockfile-drift failure.
    errorClass: 'install-timeout',
    match: /exited with 137|SIGKILL|exit code 137/i,
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
    // a field (e.g. `totalCostUsd`) but the object literal(s) that create
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
    // merge:preflight/template-leakage fires when a task branch edits a path
    // under orchestrator/src/init/templates/. The preflight categorically
    // blocks ALL orchestrator edits to that subtree — humans edit it directly
    // on main (see git.ts TEMPLATE_LEAKAGE_PREFIX comment for the historical
    // incident). Intentionally has NO registered recovery recipe: any recovery
    // agent hits the same preflight block if it tries to update the template,
    // and a recovery that skips the template edit fails the task's own verify
    // criteria. Root cause is always a task prompt that asked for the
    // impossible — requires human resolution (update template on main, then
    // handle the original task manually).
    errorClass: 'template-paths-detected',
    match: /touches \d+ init template path/i,
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
