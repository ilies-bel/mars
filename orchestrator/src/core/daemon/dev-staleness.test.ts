import { describe, expect, it } from 'vitest'
import { isStaleDev } from './dev-staleness'

describe('isStaleDev', () => {
  // ── same SHA ────────────────────────────────────────────────────────────────

  it('returns false when both SHAs are identical (no drift)', () => {
    expect(isStaleDev('abc1234', 'abc1234', 'dev')).toBe(false)
  })

  // ── SHA drift ───────────────────────────────────────────────────────────────

  it('returns true when currentSha differs from sourceSha on a dev install', () => {
    expect(isStaleDev('abc1234', 'def5678', 'dev')).toBe(true)
  })

  // ── null SHA (unknown git state) ─────────────────────────────────────────

  it('returns false when sourceSha is null (git unavailable at startup)', () => {
    expect(isStaleDev(null, 'def5678', 'dev')).toBe(false)
  })

  it('returns false when currentSha is null (git unavailable during check)', () => {
    expect(isStaleDev('abc1234', null, 'dev')).toBe(false)
  })

  it('returns false when both SHAs are null', () => {
    expect(isStaleDev(null, null, 'dev')).toBe(false)
  })

  // ── prod install ─────────────────────────────────────────────────────────

  it('returns false for a prod install even when SHAs differ', () => {
    expect(isStaleDev('abc1234', 'def5678', 'prod')).toBe(false)
  })

  it('returns false for a prod install with null sourceSha', () => {
    expect(isStaleDev(null, 'def5678', 'prod')).toBe(false)
  })
})
