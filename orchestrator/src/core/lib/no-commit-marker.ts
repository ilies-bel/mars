/**
 * Detects whether a task prompt declares up-front that it will produce no
 * commit. Such prompts are a recovery-loop pathology: the coding agent
 * correctly produces no commit, verify fails with
 * `verify:has-diff/no-commits-ahead`, a recovery is queued that reads the
 * same prompt and again produces no commit, etc.
 *
 * Patterns are intentionally conservative — they match the exact phrasing
 * that has been observed in the wild rather than any prompt that mentions
 * commits. Returns the matched phrase (for the error message) or null.
 *
 * Quoted spans (fenced code blocks, inline backticks) are stripped before
 * matching: those quote the world (git output, error messages) rather than
 * declaring intent and must not trigger the guard.
 */
const NO_COMMIT_PATTERNS: readonly RegExp[] = [
  /Nothing to commit\b/i,
  /no source[- ]code edit\s+in\s+this\s+task/i,
  /\b(?:build|install)(?:[- /]+(?:build|install))*[- ]only\s+operation/i,
  /no commit (?:is )?(?:expected|required|produced)/i,
  // Batch read-only/report tasks: "Read-only, report only, no edits"
  /read[- ]only[,\s]+report[- ]only[,\s]+no[- ]edits/i,
]

/**
 * Strip fenced code blocks (``` or ~~~) and inline backtick spans from text
 * before running the no-commit heuristic.  These regions quote external
 * content — git output, error messages, shell sessions — not intent.
 */
const stripQuotedSpans = (text: string): string => {
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (!inFence) {
      if (/^(`{3,}|~{3,})/.test(line)) {
        inFence = true
        out.push('') // replace fence-open line with blank so surrounding text stays
      } else {
        // Strip inline backtick spans (`...`) — single-line only
        out.push(line.replace(/`[^`\n]+`/g, ''))
      }
    } else {
      if (/^(`{3,}|~{3,})/.test(line)) {
        inFence = false
        out.push('') // replace fence-close line with blank
      } else {
        out.push('') // fence body → hidden
      }
    }
  }
  return out.join('\n')
}

export const detectNoCommitMarker = (prompt: string): string | null => {
  const searchable = stripQuotedSpans(prompt)
  for (const re of NO_COMMIT_PATTERNS) {
    const m = re.exec(searchable)
    if (m) return m[0]
  }
  return null
}
