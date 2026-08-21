/**
 * Canonical shared deterministic keyword-overlap scorer.
 *
 * This is the single owner of lexical-overlap logic per ADR 0006.
 * Both the deterministic Linker (proposal 2be831da) and the add-time
 * duplicate-task gate (proposal e67663e4 / task mars-c91d6807) MUST import
 * from here — do NOT fork a second scorer.
 *
 * Public API (intentionally small):
 *   tokenize(text)       → string[]            — normalised content tokens, stopwords removed
 *   overlapScore(a, b)   → Promise<number>     — similarity in [0, 1], symmetric, no LLM
 *   CONFIDENT_MATCH_THRESHOLD                  — shared threshold for "this is a confident match"
 *
 * Algorithm: Jaccard similarity over deduplicated token sets.
 * Reference shape: github.com/Dicklesworthstone/beads_viewer
 *   pkg/analysis/dependency_suggest.go + duplicates.go
 * The LabelOverlapBonus path from the reference is intentionally omitted
 * (Mars has no labels).
 */
import { resolveCodeIndex } from '../ports/code-index/registry'
import type { CodeIndex } from '../ports/code-index/types'

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
 * Compute the similarity between the meaningful keyword sets of two strings.
 *
 * The base score is the Jaccard similarity of the token sets, in [0, 1]:
 *   1 → identical non-empty token sets
 *   0 → disjoint token sets *or* either / both strings have no content tokens
 *
 * That lexical score is then blended with real symbol data from the
 * `CodeIndex` Port — resolved here, at this call boundary, via
 * `resolveCodeIndex` in `../ports/code-index/registry.ts`, never by importing
 * a concrete implementation (e.g. `codegraph.ts`) directly. When `a` and `b`
 * both resolve to symbols that live in overlapping files, the score is
 * boosted toward 1 in proportion to how much of that file set they share:
 * two differently-worded strings naming the same code are near-duplicates
 * even when their tokens barely overlap, which is exactly the case pure
 * Jaccard misses.
 *
 * With the default `none` implementation — which always returns zero hits —
 * this returns the plain Jaccard score, identical to the pre-CodeIndex
 * behaviour.
 *
 * Symmetric: overlapScore(a, b) === overlapScore(b, a).
 * Deterministic: no randomness, no LLM calls, no side effects.
 *
 * @param codeIndex - Defaults to `resolveCodeIndex()` (the env-selected
 *   implementation); tests inject a stub directly.
 */
export const overlapScore = async (
  a: string,
  b: string,
  codeIndex: CodeIndex = resolveCodeIndex(),
): Promise<number> => {
  const setA = new Set(tokenize(a))
  const setB = new Set(tokenize(b))

  let base = 0
  if (setA.size > 0 && setB.size > 0) {
    let intersectionSize = 0
    for (const tok of setA) {
      if (setB.has(tok)) intersectionSize++
    }
    base = intersectionSize / (setA.size + setB.size - intersectionSize)
  }

  const [hitsA, hitsB] = await Promise.all([
    codeIndex.search({ term: a }),
    codeIndex.search({ term: b }),
  ])
  if (hitsA.length === 0 || hitsB.length === 0) return base

  const filesA = new Set(hitsA.map((hit) => hit.filePath))
  const filesB = new Set(hitsB.map((hit) => hit.filePath))
  let sharedFiles = 0
  for (const f of filesA) if (filesB.has(f)) sharedFiles++
  if (sharedFiles === 0) return base

  const fileOverlap = sharedFiles / new Set([...filesA, ...filesB]).size
  return Math.min(1, base + fileOverlap * (1 - base))
}
