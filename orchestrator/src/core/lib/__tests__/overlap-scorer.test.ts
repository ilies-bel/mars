import { describe, expect, it } from 'vitest'
import {
  overlapScore,
  tokenize,
  CONFIDENT_MATCH_THRESHOLD,
} from '../overlap-scorer'

describe('overlapScore', () => {
  it('identical strings score 1', () => {
    expect(overlapScore('add rate limiting to api', 'add rate limiting to api')).toBe(1)
  })

  it('disjoint strings score 0', () => {
    expect(overlapScore('migrate database schema', 'render ui components')).toBe(0)
  })

  it('score is symmetric', () => {
    const a = 'add rate limiting to api endpoints'
    const b = 'update the caching layer for performance'
    expect(overlapScore(a, b)).toBe(overlapScore(b, a))
  })

  it('near-duplicate task wording scores above CONFIDENT_MATCH_THRESHOLD', () => {
    const a = 'add rate limiting to the api endpoints'
    const b = 'add rate limiting middleware to api endpoints'
    expect(overlapScore(a, b)).toBeGreaterThan(CONFIDENT_MATCH_THRESHOLD)
  })

  it('unrelated task wording scores below CONFIDENT_MATCH_THRESHOLD', () => {
    const a = 'add rate limiting to api'
    const b = 'migrate database schema to postgresql'
    expect(overlapScore(a, b)).toBeLessThan(CONFIDENT_MATCH_THRESHOLD)
  })

  it('stopwords do not inflate the score for otherwise disjoint strings', () => {
    // Only stopwords in common — should score 0 because all shared tokens are stopwords
    const a = 'the and a is'
    const b = 'the and a is'
    // Same string: identical, but we care that stopword-only strings behave consistently
    // Two strings that share ONLY stopwords should score 0
    const onlyStopA = 'the and for with'
    const onlyStopB = 'the and for but'
    // After stripping stopwords both become empty — Jaccard of two empty sets is treated as 0
    expect(overlapScore(onlyStopA, onlyStopB)).toBe(0)
  })

  it('score is in [0, 1] range', () => {
    const s = overlapScore('fix the failing tests in the workflow module', 'refactor database connection pooling')
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(1)
  })

  it('empty strings both empty score 0 (not 1)', () => {
    expect(overlapScore('', '')).toBe(0)
  })

  it('one empty string scores 0', () => {
    expect(overlapScore('add feature', '')).toBe(0)
    expect(overlapScore('', 'add feature')).toBe(0)
  })
})

describe('tokenize', () => {
  it('lowercases all tokens', () => {
    expect(tokenize('Add Rate Limiting')).toContain('rate')
    expect(tokenize('Add Rate Limiting')).toContain('limiting')
  })

  it('strips punctuation', () => {
    const tokens = tokenize('fix bug: crash on startup!')
    expect(tokens).toContain('fix')
    expect(tokens).toContain('bug')
    expect(tokens).toContain('crash')
    expect(tokens).toContain('startup')
  })

  it('removes common English stopwords', () => {
    const tokens = tokenize('the cat sat on the mat')
    expect(tokens).not.toContain('the')
    expect(tokens).not.toContain('on')
    expect(tokens).toContain('cat')
    expect(tokens).toContain('sat')
    expect(tokens).toContain('mat')
  })

  it('removes short tokens (single chars)', () => {
    const tokens = tokenize('a b c migrate database')
    expect(tokens).not.toContain('a')
    expect(tokens).not.toContain('b')
    expect(tokens).not.toContain('c')
    expect(tokens).toContain('migrate')
    expect(tokens).toContain('database')
  })

  it('returns empty array for stopword-only input', () => {
    expect(tokenize('the and a for with')).toEqual([])
  })

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('CONFIDENT_MATCH_THRESHOLD', () => {
  it('is a number between 0 and 1 exclusive', () => {
    expect(CONFIDENT_MATCH_THRESHOLD).toBeGreaterThan(0)
    expect(CONFIDENT_MATCH_THRESHOLD).toBeLessThan(1)
  })
})
