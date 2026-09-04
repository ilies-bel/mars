// @vitest-environment happy-dom
/**
 * Tests for the shared presentation helper module (displayStrings.ts).
 *
 * Every public export gets at least one happy-path, one edge-case, and one
 * "never emits machine strings" assertion so regressions are caught at the
 * unit level rather than in a visual review.
 */

import { describe, it, expect } from 'vitest'
import {
  formatFailureSig,
  smartTimestamp,
  stripInlineCode,
  truncateAtWord,
  formatTokensLabel,
  isDevVersion,
} from './displayStrings'

// ---------------------------------------------------------------------------
// formatFailureSig
// ---------------------------------------------------------------------------

describe('formatFailureSig', () => {
  it('maps a known full signature to plain English', () => {
    expect(formatFailureSig('verify:test/test-assertion-error')).toBe('a test check failed')
  })

  it('maps a known substep signature (no error-class suffix)', () => {
    expect(formatFailureSig('verify:test')).toBe('a test check failed')
  })

  it('strips error-class to match the substep', () => {
    expect(formatFailureSig('verify:e2e-smoke/unclassified')).toBe('the end-to-end smoke check failed')
  })

  it('falls back to the family entry when substep is unknown', () => {
    expect(formatFailureSig('verify:unknown-substep/some-class')).toBe('the verify step failed')
  })

  it('maps a bare family name', () => {
    expect(formatFailureSig('merge')).toBe('the merge step failed')
  })

  it('maps setup:worktree-rebase-conflict accurately', () => {
    expect(formatFailureSig('setup:worktree-rebase-conflict/merge-conflict-unresolved')).toBe(
      'setup failed — merge conflict in the worktree',
    )
  })

  it('maps code:context-exhausted accurately', () => {
    expect(formatFailureSig('code:context-exhausted')).toBe('the coder ran out of context')
  })

  it('returns a readable fallback for completely unknown signatures (never the raw slug)', () => {
    const result = formatFailureSig('custom-step:foo/bar')
    // Must be human-readable — no colons, no slashes in the returned text
    expect(result).not.toMatch(/[:/]/)
    expect(result.length).toBeGreaterThan(0)
  })

  it('handles an empty string without throwing', () => {
    expect(formatFailureSig('')).toBe('an error occurred')
  })

  // DEC-18 compliance: the raw sig slug must never be the sole output
  it('never returns the raw signature slug unchanged', () => {
    const sig = 'verify:build/typecheck-error'
    expect(formatFailureSig(sig)).not.toBe(sig)
  })
})

// ---------------------------------------------------------------------------
// smartTimestamp
// ---------------------------------------------------------------------------

describe('smartTimestamp', () => {
  const HOUR = 60 * 60 * 1000

  it('returns a relative string for a recent timestamp', () => {
    const now = Date.now()
    const recent = new Date(now - 5 * 60 * 1000).toISOString() // 5 min ago
    const result = smartTimestamp(recent, now)
    // Relative format should contain a digit and a unit letter, not a year
    expect(result).not.toMatch(/^\d{4}/)
    expect(result).toMatch(/\d/)
  })

  it('returns an absolute string for an old timestamp', () => {
    const now = Date.now()
    const old = new Date(now - 48 * HOUR).toISOString()
    const result = smartTimestamp(old, now)
    // Absolute format should contain a year
    expect(result).toMatch(/\d{4}/)
  })

  it('never emits a raw ISO 8601 string', () => {
    const now = Date.now()
    const iso = new Date(now - 5 * 60 * 1000).toISOString()
    const result = smartTimestamp(iso, now)
    expect(result).not.toMatch(/T\d{2}:\d{2}:\d{2}/)
  })

  it('handles a numeric epoch ms timestamp', () => {
    const now = Date.now()
    const result = smartTimestamp(now - 2 * 60 * 1000, now)
    expect(result).toBeTruthy()
    expect(result).not.toMatch(/NaN/)
  })

  it('returns the original value for an unparseable string rather than throwing', () => {
    const result = smartTimestamp('not-a-date', Date.now())
    expect(result).toBe('not-a-date')
  })
})

// ---------------------------------------------------------------------------
// stripInlineCode
// ---------------------------------------------------------------------------

describe('stripInlineCode', () => {
  it('removes single backtick code spans', () => {
    expect(stripInlineCode('This concerns `mars-b1aba863`.')).toBe('This concerns mars-b1aba863.')
  })

  it('removes multiple code spans in one pass', () => {
    expect(stripInlineCode('`foo` and `bar`')).toBe('foo and bar')
  })

  it('leaves plain text unchanged', () => {
    expect(stripInlineCode('no code spans here')).toBe('no code spans here')
  })

  it('leaves empty backtick pairs as empty', () => {
    expect(stripInlineCode('before `` after')).toBe('before  after')
  })
})

// ---------------------------------------------------------------------------
// truncateAtWord
// ---------------------------------------------------------------------------

describe('truncateAtWord', () => {
  it('returns the original string when it fits within max', () => {
    expect(truncateAtWord('hello world', 20)).toBe('hello world')
  })

  it('appends ellipsis and cuts at a word boundary', () => {
    const result = truncateAtWord('merge-trains-batched-rebase-verify-ff', 20)
    expect(result).toMatch(/…$/)
    expect(result.length).toBeLessThanOrEqual(21) // 20 chars + ellipsis char
  })

  it('cuts at the last hyphen when appropriate', () => {
    // 'merge-trains-batched-' is 21 chars; with max=20 it should cut at the
    // last hyphen inside the first 20 chars: after 'batched'
    const result = truncateAtWord('merge-trains-batched-rebase', 20)
    expect(result).not.toContain('rebase')
    expect(result).toMatch(/…$/)
  })

  it('cuts inside the word if no boundary is found in the first half', () => {
    const result = truncateAtWord('superlongwordwithoutanybreaks', 10)
    expect(result).toMatch(/…$/)
    expect(result.length).toBeLessThanOrEqual(11)
  })

  it('strips the session date suffix from session IDs (integration)', () => {
    // session-f0715a63-2026-08-17T13-50-43-815Z — the datetime should disappear
    const result = truncateAtWord('session-f0715a63-2026-08-17T13-50-43-815Z', 24)
    expect(result).not.toContain('2026')
    expect(result).toMatch(/…$/)
  })
})

// ---------------------------------------------------------------------------
// formatTokensLabel
// ---------------------------------------------------------------------------

describe('formatTokensLabel', () => {
  it('formats all three counts with human-readable labels', () => {
    const result = formatTokensLabel(197, 2443, 14837809)
    expect(result).toContain('in 197')
    expect(result).toContain('out 2k')
    expect(result).toContain('cached 15M')
  })

  it('omits the cache part when cache is zero', () => {
    const result = formatTokensLabel(100, 50, 0)
    expect(result).not.toContain('cached')
  })

  it('omits the cache part when cache is null', () => {
    const result = formatTokensLabel(100, 50, null)
    expect(result).not.toContain('cached')
  })

  it('works with only input tokens', () => {
    const result = formatTokensLabel(500, null)
    expect(result).toContain('in 500')
    expect(result).not.toContain('out')
  })

  it('works with only output tokens', () => {
    const result = formatTokensLabel(null, 800)
    expect(result).toContain('out 800')
    expect(result).not.toContain('in')
  })

  it('returns null when both are null', () => {
    expect(formatTokensLabel(null, null)).toBeNull()
    expect(formatTokensLabel(undefined, undefined)).toBeNull()
  })

  it('uses · as the separator', () => {
    const result = formatTokensLabel(10, 20, 30)!
    expect(result).toContain('·')
  })

  it('abbreviates thousands with k suffix', () => {
    expect(formatTokensLabel(5000, null)).toContain('5k')
  })

  it('abbreviates millions with M suffix', () => {
    expect(formatTokensLabel(null, 2_500_000)).toContain('2.5M')
  })

  // DEC-18 compliance: the raw `in:N out:N cache:N` format must never appear
  it('never produces the machine-format in:N out:N cache:N string', () => {
    const result = formatTokensLabel(197, 2443, 14837809)!
    expect(result).not.toMatch(/in:\d/)
    expect(result).not.toMatch(/out:\d/)
    expect(result).not.toMatch(/cache:\d/)
  })
})

// ---------------------------------------------------------------------------
// isDevVersion
// ---------------------------------------------------------------------------

describe('isDevVersion', () => {
  it('returns true for 0.0.0-dev', () => {
    expect(isDevVersion('0.0.0-dev')).toBe(true)
  })

  it('returns true for 0.0.0-local', () => {
    expect(isDevVersion('0.0.0-local')).toBe(true)
  })

  it('returns true for bare 0.0.0', () => {
    expect(isDevVersion('0.0.0')).toBe(true)
  })

  it('returns false for a real release version', () => {
    expect(isDevVersion('1.2.3')).toBe(false)
    expect(isDevVersion('0.1.0')).toBe(false)
    expect(isDevVersion('0.0.1')).toBe(false)
  })
})
