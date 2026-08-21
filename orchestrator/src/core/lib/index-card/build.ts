import { createHash } from 'node:crypto'
import { resolveCodeIndex } from '../../ports/code-index/registry'
import type { CodeIndex } from '../../ports/code-index/types'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GlossaryEntry {
  /** Stable identifier for cache-key purposes (e.g. slugified term). */
  id: string
  /** Human-readable term name. */
  term: string
  /** Definition shown in the card pointer snippet. */
  definition: string
}

export interface AdrEntry {
  /** Stable identifier (e.g. "adr-0056"). */
  id: string
  /** ADR title used for relevance scoring and display. */
  title: string
  /** ADR body — first 120 chars appear as the snippet. */
  body: string
}

export interface CoChange {
  /** First file in the co-change pair. */
  a: string
  /** Second file in the co-change pair. */
  b: string
  /** Optional co-occurrence count (informational). */
  count?: number
}

export interface IndexCardInput {
  taskId: string
  /** Git commit SHA the card is valid at. */
  commitSha: string
  /** Focused file shortlist for the task. */
  files: string[]
  /** Candidate glossary entries to rank and include. */
  glossary: GlossaryEntry[]
  /** Candidate ADR entries to rank and include. */
  adrs: AdrEntry[]
  /** Co-change hints for context. */
  coChanges: CoChange[]
}

export interface IndexCard {
  /** Rendered card text — deterministic given identical inputs. */
  text: string
  /** Coarse token count via the chars/4 estimator. */
  tokens: number
  /** SHA-256 over (commitSha, sorted files, sorted glossary ids, sorted adr ids). */
  cacheKey: string
  /**
   * The commitSha this card was built at.
   * The card is valid until this SHA changes; a new commitSha → new cacheKey.
   */
  staleAsOf: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_BUDGET = 2000
const MAX_POINTERS = 5
const SNIPPET_MAX_CHARS = 120
// Marker appended when the card is trimmed to fit the budget.
const TRIM_MARKER = '\n…[trimmed]'

/**
 * Ceiling on the file shortlist after CodeIndex enrichment. The card has a
 * hard token budget, so an index that returns hundreds of related files must
 * not crowd the pointers out of the rendered card.
 */
const MAX_FILES = 40

// ---------------------------------------------------------------------------
// Pure helpers (no single-caller extraction rule: all called from buildIndexCard)
// ---------------------------------------------------------------------------

/** Coarse chars/4 token estimator — mirrors the composePrompt convention. */
const countTokens = (text: string): number => Math.ceil(text.length / 4)

/**
 * Stable cache key: SHA-256 over the canonical JSON of inputs that affect card
 * content. Identical inputs → identical key.
 */
function computeCacheKey(
  commitSha: string,
  files: string[],
  glossary: GlossaryEntry[],
  adrs: AdrEntry[],
): string {
  const payload = JSON.stringify({
    commitSha,
    files: [...files].sort(),
    glossary: glossary.map((g) => g.id).sort(),
    adrs: adrs.map((a) => a.id).sort(),
  })
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * Relevance score for a glossary term or ADR title against the file shortlist.
 *
 * Score = number of files whose path contains at least one word from the label
 * (case-insensitive, words shorter than 3 chars are ignored to skip noise).
 */
function scoreTermAgainstFiles(term: string, files: string[]): number {
  const words = term.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
  if (words.length === 0) return 0
  let score = 0
  for (const file of files) {
    const lower = file.toLowerCase()
    if (words.some((w) => lower.includes(w))) score++
  }
  return score
}

interface Pointer {
  kind: 'glossary' | 'adr'
  id: string
  snippet: string
  score: number
}

/**
 * Select at most {@link MAX_POINTERS} glossary/ADR pointers ranked by relevance
 * to the file shortlist. Ties are broken by id (lexicographic, stable).
 */
function selectPointers(
  files: string[],
  glossary: GlossaryEntry[],
  adrs: AdrEntry[],
): Pointer[] {
  const candidates: Pointer[] = []

  for (const entry of glossary) {
    candidates.push({
      kind: 'glossary',
      id: entry.id,
      snippet: entry.definition.slice(0, SNIPPET_MAX_CHARS).replace(/\n/g, ' '),
      score: scoreTermAgainstFiles(entry.term, files),
    })
  }

  for (const entry of adrs) {
    candidates.push({
      kind: 'adr',
      id: entry.id,
      snippet: entry.body.slice(0, SNIPPET_MAX_CHARS).replace(/\n/g, ' '),
      score: scoreTermAgainstFiles(entry.title, files),
    })
  }

  // Descending by score, then ascending by id for a deterministic tie-break.
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

  return candidates.slice(0, MAX_POINTERS)
}

/**
 * Render the index card from its components. Returns a string ending with '\n'.
 */
function renderCard(
  taskId: string,
  commitSha: string,
  files: string[],
  pointers: Pointer[],
  coChanges: CoChange[],
): string {
  const lines: string[] = []

  lines.push('## Index Card')
  lines.push(`task: ${taskId}`)
  lines.push(`commit: ${commitSha}`)
  lines.push('')

  const sortedFiles = [...files].sort()
  lines.push(`files (${sortedFiles.length}):`)
  for (const f of sortedFiles) {
    lines.push(`  - ${f}`)
  }

  if (pointers.length > 0) {
    lines.push('')
    lines.push(`pointers (${pointers.length}):`)
    for (const p of pointers) {
      lines.push(`  [${p.kind}] ${p.id}: ${p.snippet}`)
    }
  }

  if (coChanges.length > 0) {
    lines.push('')
    lines.push('co-changes:')
    for (const c of coChanges) {
      lines.push(`  ${c.a} ↔ ${c.b}`)
    }
  }

  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/**
 * Build a deterministic, cache-key-friendly index card for a task.
 *
 * The file shortlist is first enriched through the `CodeIndex` Port —
 * resolved here, at this call boundary, via `resolveCodeIndex` in
 * `../../ports/code-index/registry.ts`, never by importing a concrete
 * implementation (e.g. `codegraph.ts`) directly. Each shortlisted path
 * contributes its basename as a search term, and any file the index reports
 * for those terms joins the shortlist (capped at {@link MAX_FILES}). Because
 * the shortlist is what `files (n):` renders and what pointer relevance is
 * scored against, real symbol data informs both.
 *
 * With the default `none` implementation — which always returns zero hits —
 * the shortlist is left exactly as supplied, so the cache key and the
 * rendered card are byte-identical to the pre-CodeIndex behaviour.
 *
 * Deterministic given identical inputs and an identical index: enrichment
 * preserves insertion order, and the card text is trimmed to the
 * {@link TOKEN_BUDGET} (2 000 tokens via chars/4) when needed. If trimming
 * cannot bring the card within budget an Error is thrown.
 *
 * @param input - Task context: taskId, commitSha, file shortlist, glossary and
 *   ADR candidates, and co-change hints.
 * @param codeIndex - Defaults to `resolveCodeIndex()` (the env-selected
 *   implementation); tests inject a stub directly.
 * @returns An {@link IndexCard} with `text`, `tokens`, `cacheKey`, and
 *   `staleAsOf` (the commitSha at which this card was built).
 */
export async function buildIndexCard(
  input: IndexCardInput,
  codeIndex: CodeIndex = resolveCodeIndex(),
): Promise<IndexCard> {
  const { taskId, commitSha, glossary, adrs, coChanges } = input

  const files = [...input.files]
  const seen = new Set(files)
  const terms = new Set(
    input.files
      .map((f) => (f.split('/').pop() ?? '').replace(/\.[^.]+$/, ''))
      .filter((t) => t.length > 2),
  )
  for (const term of terms) {
    if (files.length >= MAX_FILES) break
    for (const hit of await codeIndex.search({ term })) {
      if (seen.has(hit.filePath)) continue
      seen.add(hit.filePath)
      files.push(hit.filePath)
      if (files.length >= MAX_FILES) break
    }
  }

  const cacheKey = computeCacheKey(commitSha, files, glossary, adrs)
  const pointers = selectPointers(files, glossary, adrs)

  let text = renderCard(taskId, commitSha, files, pointers, coChanges)
  let tokens = countTokens(text)

  if (tokens > TOKEN_BUDGET) {
    // Trim to exactly TOKEN_BUDGET * 4 chars: slice + fixed-length marker.
    text = text.slice(0, TOKEN_BUDGET * 4 - TRIM_MARKER.length) + TRIM_MARKER
    tokens = countTokens(text)
    if (tokens > TOKEN_BUDGET) {
      throw new Error(
        `buildIndexCard: card cannot be trimmed to the ${TOKEN_BUDGET}-token budget (${tokens} tokens after trim)`,
      )
    }
  }

  return { text, tokens, cacheKey, staleAsOf: commitSha }
}
