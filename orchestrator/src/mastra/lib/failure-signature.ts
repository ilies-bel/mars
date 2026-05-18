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
  match: RegExp | string
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
    errorClass: 'not-fast-forward',
    match: /is not a fast-forward of/i,
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
    errorClass: 'merge-conflict-unresolved',
    match: /CONFLICT|fix conflicts/i,
  },
]

export const classifyError = (errorOutput: string): string => {
  const head = firstNonBlankLine(errorOutput)
  if (head.length === 0) return UNCLASSIFIED_ERROR_CLASS
  for (const rule of errorClassRules) {
    if (typeof rule.match === 'string') {
      if (head.includes(rule.match)) return rule.errorClass
    } else {
      if (rule.match.test(head)) return rule.errorClass
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
