import { describe, expect, it } from 'bun:test'
import { formatRelativeAgeFromHours } from './time'

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
})
