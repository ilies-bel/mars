/**
 * Time-based bucket classification for Todo sidebar items.
 *
 * Buckets are ordered from freshest to oldest. Items with zero count are hidden
 * from the header summary.
 */

export type BucketLabel = 'today' | 'yesterday' | 'this week' | 'older'

/** Canonical display order: freshest first. */
export const BUCKET_ORDER: readonly BucketLabel[] = [
  'today',
  'yesterday',
  'this week',
  'older',
]

/**
 * Map an item's age (in hours) to a time bucket label.
 *
 *   < 24h  → today
 *   24–48h → yesterday
 *   48–168h → this week
 *   ≥ 168h → older
 */
export const getBucketFromHours = (ageHours: number): BucketLabel => {
  if (ageHours < 24) return 'today'
  if (ageHours < 48) return 'yesterday'
  if (ageHours < 168) return 'this week'
  return 'older'
}
