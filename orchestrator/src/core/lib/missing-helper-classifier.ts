/**
 * Classifies failure signatures and reflection excerpts into normalized
 * missing-helper keys so later slices can generate targeted helper code.
 *
 * Returns a MissingHelperMatch with a stable helperKey (e.g.
 * 'helper:rg', 'codegraph-diff', 'bash-loop-runner') and an evidence
 * string anchoring the match to its source. Returns null when no pattern
 * fires — callers must not treat null as an error; it simply means no
 * helper gap was detected for this input.
 */

/**
 * Coarse-grained failure description passed to classifyMissingHelper.
 * reasonCode drives branch selection; snippet is the raw error excerpt.
 */
export interface FailureSignature {
  /** Coarse error category, e.g. 'COMMAND_NOT_FOUND', 'MODULE_NOT_FOUND'. */
  reasonCode: string
  /** Raw error output excerpt from the failing step. */
  snippet: string
}

/** Normalized match returned when a missing-helper pattern fires. */
export type MissingHelperMatch = {
  /** Stable key identifying the missing helper, e.g. 'helper:rg'. */
  helperKey: string
  /** Verbatim excerpt that triggered the match, for traceability. */
  evidence: string
}

/**
 * Maps a failure signature (and optional reflection-report excerpt) to a
 * normalized missing-helper key, or null when no pattern fires.
 *
 * Three detection branches, in priority order:
 *
 * 1. COMMAND_NOT_FOUND — snippet contains a bash "command not found" error;
 *    helperKey = 'helper:<command>'.
 *
 * 2. MODULE_NOT_FOUND — snippet contains a Node/TypeScript module resolution
 *    failure; helperKey = the quoted module specifier.
 *
 * 3. reflection — a reflection-report excerpt names a missing helper via
 *    "missing helper: <name>"; helperKey = the named helper.
 */
export function classifyMissingHelper(
  sig: FailureSignature,
  reflection?: string,
): MissingHelperMatch | null {
  // Branch 1: repeated 'command not found' errors
  if (sig.reasonCode === 'COMMAND_NOT_FOUND') {
    const m = sig.snippet.match(/([\w][\w.-]*):\s*command not found/)
    if (!m) return null
    return { helperKey: `helper:${m[1]}`, evidence: sig.snippet }
  }

  // Branch 2: repeated identical rg+Read sweeps (missing module/tool)
  if (sig.reasonCode === 'MODULE_NOT_FOUND') {
    const m = sig.snippet.match(/Cannot find module ['"]([^'"]+)['"]/)
    if (!m) return null
    return { helperKey: m[1], evidence: sig.snippet }
  }

  // Branch 3: repeated bash-loop patterns described in reflection
  if (reflection !== undefined && reflection.length > 0) {
    const m = reflection.match(/missing helper[:\s]+([\w][\w:-]*)/i)
    if (m) return { helperKey: m[1], evidence: m[0] }
  }

  return null
}
