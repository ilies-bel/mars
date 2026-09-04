/**
 * displayStrings — one shared presentation layer for machine strings.
 *
 * Every surface that needs to turn a raw id, failure signature, ISO timestamp,
 * markdown snippet, slug, or token count into a readable label imports from
 * here rather than inventing its own formatting. The goal: no page face shows a
 * bare id, a raw failure signature, a raw ISO timestamp, or a literal backtick.
 *
 * Functions:
 *   formatFailureSig   — failure-signature slug → full English sentence
 *   smartTimestamp     — ISO/epoch → relative if recent, absolute if older
 *   stripInlineCode    — remove backtick code spans from plain-text contexts
 *   truncateAtWord     — word-boundary truncation with ellipsis
 *   formatTokensLabel  — raw token counts → labelled "in N · out N · cached N"
 *   isDevVersion       — detect 0.0.0-dev build sentinels
 */

import { relativeTime, formatAbsoluteDateTime } from './time'

// ---------------------------------------------------------------------------
// 1. Failure-signature → sentence
// ---------------------------------------------------------------------------

/**
 * Signature–phrase table. Keys are matched longest-first so that a specific
 * substep like 'verify:test' wins over the bare family 'verify' for a
 * signature like 'verify:test/test-assertion-error'.
 *
 * Every entry is a sentence fragment — no leading capital, no trailing period —
 * so callers can embed it naturally in a longer sentence if needed.
 */
const SIG_PHRASES: Record<string, string> = {
  // merge ────────────────────────────────────────────────────────────────────
  'merge:hard-timeout':  'the merge step timed out',
  'merge:conflict':      'the merge had conflicts',
  'merge:dirty-main':    'the merge target was dirty',
  'merge:crashed':       'the merge step crashed internally',
  merge:                'the merge step failed',
  // verify — granular substeps first so they win over the family prefix ─────
  'verify:test':         'a test check failed',
  'verify:e2e-smoke':    'the end-to-end smoke check failed',
  'verify:build':        'the build check failed',
  'verify:typecheck':    'the typecheck failed',
  'verify:has-diff':     'the branch has uncommitted changes',
  'verify:dirty-main':   'the integration branch was dirty',
  'verify:knip':         'the unused-exports check failed',
  'verify:lint':         'the linter check failed',
  verify:               'the verify step failed',
  // code ─────────────────────────────────────────────────────────────────────
  'code:context-exhausted': 'the coder ran out of context',
  'code:timeout':           'the coding step timed out',
  'code:over-budget':       'the coder exceeded its token budget',
  code:                    'the coding step failed',
  // setup ────────────────────────────────────────────────────────────────────
  'setup:worktree-rebase-conflict': 'setup failed — merge conflict in the worktree',
  'setup:install-failed':           'setup failed — package install failed',
  setup:                           'the setup step failed',
  // misc ─────────────────────────────────────────────────────────────────────
  'daemon-killed':       'the daemon was killed mid-step',
  tool_timeout:          'a tool call timed out',
  'e2e-tooling-missing': 'end-to-end tooling is missing',
}

/**
 * Map a raw failure signature to a plain-language sentence fragment.
 *
 * Resolution order:
 *   1. Exact match in SIG_PHRASES.
 *   2. Strip the error-class suffix after '/': 'verify:test/test-assertion-error' → 'verify:test'.
 *   3. Strip the substep after ':': 'verify:test' → 'verify'.
 *   4. Generic fallback — the step family in readable form (never the raw slug alone).
 *
 * Returns a sentence fragment — lowercase, no trailing period — that callers
 * can prefix with a capital or embed as-is.
 */
export const formatFailureSig = (sig: string): string => {
  if (!sig) return 'an error occurred'
  // 1. Exact match.
  if (SIG_PHRASES[sig]) return SIG_PHRASES[sig]!
  // 2. Strip error-class suffix.
  const withoutClass = sig.split('/')[0]!
  if (SIG_PHRASES[withoutClass]) return SIG_PHRASES[withoutClass]!
  // 3. Strip substep → bare step family.
  const family = withoutClass.split(':')[0]!
  if (SIG_PHRASES[family]) return SIG_PHRASES[family]!
  // 4. Generic: make the family human-readable (hyphens/underscores → spaces).
  return `${family.replace(/[_-]/g, ' ')} failed`
}

// ---------------------------------------------------------------------------
// 2. Smart timestamp — relative when fresh, absolute otherwise
// ---------------------------------------------------------------------------

/** Show relative time within this window; otherwise fall back to absolute. */
const RELATIVE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 h

/**
 * Format a timestamp as a relative string ("5m ago") when it is within 24 h
 * of now, and as an unambiguous absolute ("4 Sep 2026, 16:12") when older.
 *
 * Never emits a raw ISO 8601 string on the page face.
 */
export const smartTimestamp = (ts: string | number, now = Date.now()): string => {
  const t = new Date(ts).getTime()
  if (Number.isNaN(t)) return String(ts)
  if (now - t < RELATIVE_WINDOW_MS) return relativeTime(ts, now)
  return formatAbsoluteDateTime(ts)
}

// ---------------------------------------------------------------------------
// 3. Strip inline code spans — for plain-text contexts
// ---------------------------------------------------------------------------

/**
 * Strip backtick inline-code spans from a string, returning plain text.
 *
 * Used when text must appear in a context that does not have a Markdown
 * renderer — e.g. a chat seed message that is displayed as raw characters
 * rather than processed HTML. Without this, `` `mars-b1aba863` `` renders as
 * literal backticks on screen rather than styled code.
 */
export const stripInlineCode = (text: string): string =>
  text.replace(/`([^`]*)`/g, '$1')

// ---------------------------------------------------------------------------
// 4. Word-boundary truncation
// ---------------------------------------------------------------------------

/**
 * Truncate `text` at `max` characters, cutting at the last word boundary
 * (space or hyphen) within the limit. Appends "…" when truncated.
 *
 * A PRD slug like "merge-trains-batched-rebase-verify-ff" becomes
 * "merge-trains-batched-rebase-…" rather than cutting mid-syllable.
 */
export const truncateAtWord = (text: string, max: number): string => {
  if (text.length <= max) return text
  const slice = text.slice(0, max)
  const boundary = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('-'))
  const cut = boundary > max / 2 ? slice.slice(0, boundary) : slice
  return `${cut.trimEnd()}…`
}

// ---------------------------------------------------------------------------
// 5. Token / context counters — labelled
// ---------------------------------------------------------------------------

const formatCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/**
 * Format raw token counts as a labelled string for display.
 *
 * Returns null when no counts are available so callers can skip rendering.
 *
 * Format: "in 197 · out 2k · cached 15M"
 *
 * This replaces the machine-format `in:197 out:2443 cache:14837809` that was
 * appearing on the page face as unlabelled developer telemetry (DEC-18).
 */
export const formatTokensLabel = (
  input: number | null | undefined,
  output: number | null | undefined,
  cache?: number | null,
): string | null => {
  const parts: string[] = []
  if (input != null) parts.push(`in ${formatCount(input)}`)
  if (output != null) parts.push(`out ${formatCount(output)}`)
  if (cache != null && cache > 0) parts.push(`cached ${formatCount(cache)}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

// ---------------------------------------------------------------------------
// 6. Version sentinel detection
// ---------------------------------------------------------------------------

/**
 * True when `v` is a dev-build sentinel that should be hidden from the UI.
 *
 * A dev build version like "0.0.0-dev" or "0.0.0-local" is not a real
 * release version and should not be displayed as "mars v0.0.0-dev" in the
 * footer — that confuses consumers who cannot distinguish it from a real
 * release. Show nothing when this returns true.
 */
export const isDevVersion = (v: string): boolean => /^0\.0\.0/.test(v)
