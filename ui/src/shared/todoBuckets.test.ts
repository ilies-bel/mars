import { describe, expect, it } from 'bun:test'
import { getBucketFromHours, BUCKET_ORDER, type BucketLabel } from './todoBuckets'

describe('getBucketFromHours', () => {
  it('returns "today" for items less than 24 hours old', () => {
    expect(getBucketFromHours(0)).toBe('today')
    expect(getBucketFromHours(1)).toBe('today')
    expect(getBucketFromHours(23.9)).toBe('today')
  })

  it('returns "yesterday" for items 24–48 hours old', () => {
    expect(getBucketFromHours(24)).toBe('yesterday')
    expect(getBucketFromHours(36)).toBe('yesterday')
    expect(getBucketFromHours(47.9)).toBe('yesterday')
  })

  it('returns "this week" for items 48–168 hours old', () => {
    expect(getBucketFromHours(48)).toBe('this week')
    expect(getBucketFromHours(100)).toBe('this week')
    expect(getBucketFromHours(167.9)).toBe('this week')
  })

  it('returns "older" for items 168 hours or more old', () => {
    expect(getBucketFromHours(168)).toBe('older')
    expect(getBucketFromHours(720)).toBe('older')
  })
})

describe('BUCKET_ORDER', () => {
  it('lists buckets from freshest to oldest', () => {
    const expected: BucketLabel[] = ['today', 'yesterday', 'this week', 'older']
    expect(BUCKET_ORDER).toEqual(expected)
  })
})
