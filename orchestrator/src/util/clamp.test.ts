import { describe, expect, it } from 'vitest'
import { clamp } from './clamp.js'

describe('clamp', () => {
  it('returns value unchanged when already within bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  it('returns min when value is below lower bound', () => {
    expect(clamp(-3, 0, 10)).toBe(0)
  })

  it('returns max when value is above upper bound', () => {
    expect(clamp(15, 0, 10)).toBe(10)
  })

  it('returns min when value equals min (inclusive boundary)', () => {
    expect(clamp(0, 0, 10)).toBe(0)
  })

  it('returns max when value equals max (inclusive boundary)', () => {
    expect(clamp(10, 0, 10)).toBe(10)
  })

  it('handles negative ranges', () => {
    expect(clamp(-5, -10, -1)).toBe(-5)
    expect(clamp(0, -10, -1)).toBe(-1)
    expect(clamp(-20, -10, -1)).toBe(-10)
  })

  it('returns the single value when min equals max', () => {
    expect(clamp(7, 4, 4)).toBe(4)
  })
})
