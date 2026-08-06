import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Schema — mirrors the Scorer type from orchestrator/src/core/scorers.ts.
// Only the fields the UI needs to render the suggestion panel are validated
// here; the rubric (full scoring prompt) is intentionally included so the
// operator can read it before accepting.
// ---------------------------------------------------------------------------

export const suggestedScorerSchema = z.object({
  id: z.string().min(1),
  workflow: z.string().min(1),
  title: z.string().min(1),
  rubric: z.string().min(1),
  status: z.literal('suggested'),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type SuggestedScorer = z.infer<typeof suggestedScorerSchema>

const scorerSuggestionsResponseSchema = z.object({
  scorers: z.array(suggestedScorerSchema),
})

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

interface ScorerSuggestionsState {
  scorers: SuggestedScorer[]
  isLoading: boolean
  error: Error | null
}

/**
 * Fetches the list of suggested scorers that have not yet been accepted or
 * dismissed. Returns them ordered newest-first (server side).
 *
 * Hits GET /api/scorer-suggestions which the UI server proxies to the
 * daemon's GET /view/scorer-suggestions endpoint.
 */
export const useScorerSuggestions = (): ScorerSuggestionsState => {
  const query = useQuery({
    queryKey: ['scorer-suggestions'],
    queryFn: async () => {
      const res = await fetch('/api/scorer-suggestions')
      if (!res.ok) throw new Error(`GET /api/scorer-suggestions → ${res.status}`)
      const raw: unknown = await res.json()
      return scorerSuggestionsResponseSchema.parse(raw)
    },
  })

  return {
    scorers: query.data?.scorers ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
