/**
 * isDestructiveVerb — single authoritative predicate for "does this verb
 * destroy work?"
 *
 * Consolidates two previously divergent surface definitions:
 *   - ActionQueueRow (widget):  array ['purge','drop','restart','dismiss','reject']
 *     applied to op strings only.
 *   - TriagePage (page):  regex /\b(restart|purge|drop|delete|retire|discard|
 *     wipe|remove|abort|reset)\b/i applied to both op and label, OR'd with
 *     v.style === 'destructive'.
 *
 * The merged set covers both prior definitions (adding dismiss/reject from the
 * widget to the regex, and adding the style check). The two definitions could
 * only disagree in the dangerous direction — a false negative dresses a
 * work-destroying verb as the safe default — so the union is the only safe
 * merge strategy.
 *
 * restart-daemon carve-out: The op `restart-daemon` / label "restart engine"
 * pattern bypasses the daemon-bounce from the destructive category (the
 * daemon recovers in-flight tasks, nothing is lost). The carve-out is
 * evaluated PER STRING — so op `restart-daemon` is safe, but a label of
 * `'Restart daemon'` (space, not hyphen) does NOT match SAFE_RE and correctly
 * falls through to the destructive test. Every server-provided verb whose
 * label contains `restart` still requires confirmation, even when its op is
 * the carve-out op.
 */

const SAFE_RE = /\brestart[-_]?daemon\b|restart.?engine/i
const DESTRUCTIVE_RE =
  /\b(restart|purge|drop|delete|retire|discard|wipe|remove|abort|reset|dismiss|reject)\b/i

/**
 * Is a single string (op or label) destructive?
 *
 * The safe check is evaluated PER STRING, not globally. This matters for
 * `restart-daemon` / `'Restart daemon'`:
 *   - op `'restart-daemon'` → matches SAFE_RE → not destructive
 *   - label `'Restart daemon'` → does NOT match SAFE_RE (space, not hyphen) →
 *     `restart` matches DESTRUCTIVE_RE → destructive
 *
 * Checking both fields together with a global safe-short-circuit would make
 * `restart-daemon`'s safe op suppress the destructive label, which is wrong.
 */
function isDestructiveString(s: string): boolean {
  if (SAFE_RE.test(s)) return false
  return DESTRUCTIVE_RE.test(s)
}

/**
 * Does this verb or decision destroy work?
 *
 * Accepts the minimal shape shared by AlertVerb and Decision so callers do not
 * need to adapt their types. Every field is optional — callers that only have
 * one field (e.g. just an op string) can omit the rest.
 */
export function isDestructiveVerb(verb: {
  op?: string
  label?: string
  style?: string
}): boolean {
  if (verb.style === 'destructive') return true
  return isDestructiveString(verb.op ?? '') || isDestructiveString(verb.label ?? '')
}
