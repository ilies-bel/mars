import { describe, expect, it } from 'bun:test'
import { formatRelativeAge, formatRelativeAgeFromHours } from './time'

const SEC = 1_000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const YEAR = 365 * DAY

describe('formatRelativeAge — bucket boundaries', () => {
  it('< 1m returns "just now"', () => {
    expect(formatRelativeAge(0)).toBe('just now')
    expect(formatRelativeAge(59 * SEC)).toBe('just now')
  })

  it('flips from "just now" to minutes at 60s', () => {
    expect(formatRelativeAge(60 * SEC)).toBe('1m')
  })

  it('< 60m returns minutes (rounded down)', () => {
    expect(formatRelativeAge(59 * MIN)).toBe('59m')
  })

  it('flips from minutes to hours at 60m', () => {
    expect(formatRelativeAge(60 * MIN)).toBe('1h')
  })

  it('< 24h returns hours (rounded down, no decimal)', () => {
    expect(formatRelativeAge(23 * HOUR + 59 * MIN)).toBe('23h')
  })

  it('flips from hours to days at 24h', () => {
    expect(formatRelativeAge(24 * HOUR)).toBe('1d')
  })

  it('< 7d returns days (rounded down)', () => {
    expect(formatRelativeAge(6 * DAY)).toBe('6d')
  })

  it('flips from days to weeks at 7d', () => {
    expect(formatRelativeAge(7 * DAY)).toBe('1w')
  })

  it('< 5w returns weeks (rounded down)', () => {
    expect(formatRelativeAge(4 * WEEK + 6 * DAY)).toBe('4w')
  })

  it('flips from weeks to months at 5w', () => {
    // 5w = 35 days; 35 / 30 = 1mo
    expect(formatRelativeAge(5 * WEEK)).toBe('1mo')
  })

  it('treats 31d as still in the weeks bucket (boundary is 5w, not 30d)', () => {
    // The bucket rule says < 5w → Nw; 31d = 4w3d, so it stays "4w".
    expect(formatRelativeAge(31 * DAY)).toBe('4w')
  })

  it('returns months once past the 5w cutoff', () => {
    expect(formatRelativeAge(5 * WEEK + 1 * DAY)).toBe('1mo')
    expect(formatRelativeAge(60 * DAY)).toBe('2mo')
  })

  it('flips from months to years at 1y', () => {
    expect(formatRelativeAge(YEAR)).toBe('1y')
  })

  it('returns years past the 1y mark', () => {
    expect(formatRelativeAge(2 * YEAR)).toBe('2y')
  })

  it('clamps negative input to "just now"', () => {
    expect(formatRelativeAge(-1)).toBe('just now')
  })

  it('never returns a decimal-hours string like "73.4h"', () => {
    // Regression: the actionQueue card used to render "73.4H" via toFixed(1).
    expect(formatRelativeAge(73.4 * HOUR)).toBe('3d')
    expect(formatRelativeAge(73.4 * HOUR)).not.toMatch(/\./)
  })
})

describe('formatRelativeAgeFromHours', () => {
  it('returns "just now" for 0 hours', () => {
    expect(formatRelativeAgeFromHours(0)).toBe('just now')
  })

  it('returns minutes for sub-hour values', () => {
    expect(formatRelativeAgeFromHours(0.5)).toBe('30m')
  })

  it('returns hours for values under 24 hours', () => {
    expect(formatRelativeAgeFromHours(3)).toBe('3h')
    expect(formatRelativeAgeFromHours(23)).toBe('23h')
  })

  it('returns days for values 24h or more up to a week', () => {
    expect(formatRelativeAgeFromHours(24)).toBe('1d')
    expect(formatRelativeAgeFromHours(48)).toBe('2d')
    expect(formatRelativeAgeFromHours(167)).toBe('6d')
  })

  it('returns weeks for values 1–5 weeks', () => {
    expect(formatRelativeAgeFromHours(168)).toBe('1w')
    expect(formatRelativeAgeFromHours(336)).toBe('2w')
  })

  it('returns a human-readable string instead of raw hours+h suffix', () => {
    // The stale detail Age field should not render bare numbers like "48h"
    // — it should use the formatted representation
    const result = formatRelativeAgeFromHours(48)
    expect(result).not.toMatch(/^\d+h$/)
    expect(result).toBe('2d')
  })

  it('regression: a 73.4-hour-old item renders as days, not "73.4h"', () => {
    expect(formatRelativeAgeFromHours(73.4)).toBe('3d')
  })
})
