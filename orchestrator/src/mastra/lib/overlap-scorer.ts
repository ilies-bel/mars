/**
 * Canonical shared deterministic keyword-overlap scorer.
 *
 * This is the single owner of lexical-overlap logic per ADR 0006.
 * Both the deterministic Linker (idea 2be831da) and the add-time
 * duplicate-task gate (idea e67663e4 / task mars-c91d6807) MUST import
 * from here — do NOT fork a second scorer.
 *
 * Public API (intentionally small):
 *   tokenize(text)       → string[]   — normalised content tokens, stopwords removed
 *   overlapScore(a, b)   → number     — Jaccard similarity in [0, 1], symmetric, no LLM
 *   CONFIDENT_MATCH_THRESHOLD         — shared threshold for "this is a confident match"
 *
 * Algorithm: Jaccard similarity over deduplicated token sets.
 * Reference shape: github.com/Dicklesworthstone/beads_viewer
 *   pkg/analysis/dependency_suggest.go + duplicates.go
 * The LabelOverlapBonus path from the reference is intentionally omitted
 * (Mars has no labels).
 */

/**
 * Common English stopwords. Stored as a Set for O(1) lookup.
 * Internal — consumers call `tokenize`, not this set directly.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet', 'for',
  'in', 'on', 'at', 'to', 'of', 'with', 'by', 'from', 'as', 'into',
  'through', 'after', 'before', 'between', 'up', 'out', 'is', 'was',
  'are', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do',
  'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'shall', 'can', 'not', 'no', 'this', 'that', 'these', 'those', 'it',
  'its', 'i', 'we', 'you', 'he', 'she', 'they', 'me', 'us', 'him',
  'her', 'them', 'my', 'our', 'your', 'his', 'their', 'what', 'which',
  'who', 'when', 'where', 'why', 'how', 'all', 'each', 'if', 'than',
  's', 'also', 'just', 'more', 'other', 'such', 'any', 'about', 'over',
  'then', 'there', 'here', 'both', 'same', 'much', 'many', 'some',
])

/**
 * Minimum token length after stopword removal.
 * Single-character tokens (e.g. lone 'a', 'b') are discarded.
 */
const MIN_TOKEN_LENGTH = 2

/**
 * Normalise `text` into a deduplicated list of content tokens.
 *
 * Steps:
 *  1. Lowercase.
 *  2. Split on any non-alphanumeric run (colons, dashes, underscores, spaces, punctuation).
 *  3. Drop tokens shorter than MIN_TOKEN_LENGTH.
 *  4. Drop stopwords.
 *
 * Exported so callers can inspect/debug the tokenisation step independently.
 */
export const tokenize = (text: string): string[] => {
  const raw = text.toLowerCase().split(/[^a-z0-9]+/)
  const result: string[] = []
  const seen = new Set<string>()
  for (const tok of raw) {
    if (tok.length < MIN_TOKEN_LENGTH) continue
    if (STOPWORDS.has(tok)) continue
    if (seen.has(tok)) continue
    seen.add(tok)
    result.push(tok)
  }
  return result
}

/**
 * Confidence threshold for "this is a confident duplicate match."
 *
 * Both the Linker and the add-time gate import this constant so they stay
 * in lock-step. Tuning it here automatically adjusts both consumers.
 *
 * 0.35 corresponds to roughly 35% Jaccard overlap of meaningful tokens —
 * enough to flag near-duplicate task phrasings while tolerating unrelated
 * tasks that incidentally share a word or two.
 */
export const CONFIDENT_MATCH_THRESHOLD = 0.35

/**
 * Compute the Jaccard similarity between the meaningful keyword sets of
 * two strings.
 *
 * Returns a value in [0, 1]:
 *   1 → identical non-empty token sets
 *   0 → disjoint token sets *or* either / both strings have no content tokens
 *
 * Symmetric: overlapScore(a, b) === overlapScore(b, a).
 * Deterministic: no randomness, no LLM calls, no side effects.
 */
export const overlapScore = (a: string, b: string): number => {
  const setA = new Set(tokenize(a))
  const setB = new Set(tokenize(b))

  if (setA.size === 0 || setB.size === 0) return 0

  let intersectionSize = 0
  for (const tok of setA) {
    if (setB.has(tok)) intersectionSize++
  }

  const unionSize = setA.size + setB.size - intersectionSize
  return intersectionSize / unionSize
}
