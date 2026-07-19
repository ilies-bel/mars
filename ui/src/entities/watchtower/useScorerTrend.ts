import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Server response schema — matches what /api/scorer-trend returns
// (daemon: viewScorerTrend → { trends: ScorerTrend[]; recent: ScorerResult[] })
// ---------------------------------------------------------------------------

const scorerResultSchema = z.object({
  id: z.string(),
  score: z.number().nullable(),
  workflow: z.string(),
  status: z.enum(['scored', 'error']),
  createdAt: z.number(),
})

const scorerTrendSchema = z.object({
  workflow: z.string(),
  sampleCount: z.number(),
  errorCount: z.number(),
  median: z.number().nullable(),
  p90: z.number().nullable(),
  latest: z.number().nullable(),
})

const scorerTrendResponseSchema = z.object({
  trends: z.array(scorerTrendSchema),
  recent: z.array(scorerResultSchema),
})

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ScorerTrendPoint {
  createdAt: string
  score: number
}

export interface ScorerTrendState {
  points: ScorerTrendPoint[]
  median: number | null
  p90: number | null
  isLoading: boolean
  error: Error | null
}

/**
 * Fetches the score trend for a single workflow kind over a trailing window.
 * Returns per-point data for charting plus pre-computed median and p90 stats.
 *
 * Hits GET /api/scorer-trend?workflow=<kind>&window=<n> which the UI server
 * proxies to the daemon's /view/scorer-trend endpoint.
 */
export const useScorerTrend = (workflow: string, window = 20): ScorerTrendState => {
  const query = useQuery({
    queryKey: ['scorer-trend', workflow, window],
    queryFn: async () => {
      const res = await fetch(
        `/api/scorer-trend?workflow=${encodeURIComponent(workflow)}&window=${window}`,
      )
      if (!res.ok) throw new Error(`GET /api/scorer-trend → ${res.status}`)
      const raw: unknown = await res.json()
      return scorerTrendResponseSchema.parse(raw)
    },
  })

  const trend = query.data?.trends[0]
  const recent = query.data?.recent ?? []

  return {
    points: recent
      .filter((r) => r.status === 'scored' && r.score !== null)
      .map((r) => ({
        createdAt: new Date(r.createdAt).toISOString(),
        score: r.score as number,
      })),
    median: trend?.median ?? null,
    p90: trend?.p90 ?? null,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
