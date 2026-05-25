/**
 * Pure model for the recency slider on the Progress tab.
 *
 * Kept in a plain `.ts` file (no JSX) so the server tsconfig can type-check
 * the corresponding test file without needing jsx support.
 */

export type RecencyStop = '1h' | '6h' | '24h' | '7d' | '30d' | 'all'

export const RECENCY_STOPS: readonly RecencyStop[] = [
  '1h',
  '6h',
  '24h',
  '7d',
  '30d',
  'all',
]

export const RECENCY_STOP_DEFAULT: RecencyStop = '24h'

/**
 * Converts a RecencyStop label to a millisecond window for the
 * `?failedWindow` API query parameter. Returns `null` for the "all" stop
 * (no recency cutoff — every failed task is in scope).
 */
export const recencyStopToMs = (stop: RecencyStop): number | null => {
  switch (stop) {
    case '1h':
      return 1 * 60 * 60 * 1000
    case '6h':
      return 6 * 60 * 60 * 1000
    case '24h':
      return 24 * 60 * 60 * 1000
    case '7d':
      return 7 * 24 * 60 * 60 * 1000
    case '30d':
      return 30 * 24 * 60 * 60 * 1000
    case 'all':
      return null
  }
}
