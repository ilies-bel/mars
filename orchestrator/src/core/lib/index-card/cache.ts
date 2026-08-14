/**
 * Disk cache for index cards (PRD 74d76a78 Phase 4A, slice 2 of 6).
 *
 * Each card is keyed by the SHA-256 hash that `buildIndexCard` computes over
 * (commitSha, sorted files, sorted glossary ids, sorted adr ids). With the
 * tracer-bullet's empty glossary and adrs, the key is effectively over
 * (commitSha, sorted files), making it stable across re-runs as long as the
 * integration HEAD and file shortlist are unchanged.
 *
 * Cache path: `<stateDir>/index-cards/<cacheKey>.txt`
 *
 * On a MISS: builds the card and writes it.
 * On a HIT:  reads the file and returns without rebuilding or rewriting.
 *
 * The file mtime is therefore only set once per (commitSha, files) tuple —
 * callers can assert `stat.mtime` is unchanged across two calls to verify
 * the cache path was taken.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getStateDir } from '../../context.js'
import { buildIndexCard } from './build.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LoadOrBuildArgs {
  /** Owning task id — embedded in the card text. */
  taskId: string
  /** Git SHA the card is valid at (integration HEAD at setup time). */
  commitSha: string
  /** Focused file shortlist extracted from `spec.files`. */
  files: readonly string[]
}

export interface LoadOrBuildResult {
  /** Rendered card text, exactly as stored in the cache file. */
  text: string
  /** SHA-256 cache key that identifies the on-disk file. */
  cacheKey: string
  /** Coarse token count (chars/4). */
  tokens: number
  /** `true` when the result was read from the existing cache file. */
  cacheHit: boolean
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/**
 * Load the index card from disk, or build and persist it on a cache miss.
 *
 * Glossary and ADR entries are deliberately empty in this tracer-bullet slice;
 * future slices will supply them from the task store. The cache key is still
 * correct because the key covers the input ids (which are empty here, and
 * therefore stable).
 *
 * @throws When the state directory cannot be created or the file cannot be
 *   written. Callers should treat all errors as non-fatal and swallow them.
 */
export function loadOrBuildIndexCard(args: LoadOrBuildArgs): LoadOrBuildResult {
  const { taskId, commitSha, files } = args

  // Build the card (pure, no I/O) to obtain the deterministic cacheKey.
  // The glossary and adrs are intentionally empty: a future slice will enrich
  // them with real domain content. The key will change then because the id
  // lists differ, so existing cached files are naturally invalidated.
  const card = buildIndexCard({
    taskId,
    commitSha,
    files: [...files],
    glossary: [],
    adrs: [],
    coChanges: [],
  })

  const cacheDir = join(getStateDir(), 'index-cards')
  const cachePath = join(cacheDir, `${card.cacheKey}.txt`)

  if (existsSync(cachePath)) {
    // Cache HIT: read the persisted text without rewriting (mtime unchanged).
    const text = readFileSync(cachePath, 'utf8')
    return { text, cacheKey: card.cacheKey, tokens: card.tokens, cacheHit: true }
  }

  // Cache MISS: persist the card text so the next call is a hit.
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(cachePath, card.text, 'utf8')

  return { text: card.text, cacheKey: card.cacheKey, tokens: card.tokens, cacheHit: false }
}
