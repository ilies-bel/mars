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
 */
const NO_COMMIT_PATTERNS: readonly RegExp[] = [
  /Nothing to commit\b/i,
  /no source[- ]code edit\s+in\s+this\s+task/i,
  /\b(?:build|install)(?:[- /]+(?:build|install))*[- ]only\s+operation/i,
  /no commit (?:is )?(?:expected|required|produced)/i,
]

export const detectNoCommitMarker = (prompt: string): string | null => {
  for (const re of NO_COMMIT_PATTERNS) {
    const m = re.exec(prompt)
    if (m) return m[0]
  }
  return null
}
