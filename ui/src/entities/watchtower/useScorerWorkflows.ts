import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Server response schema — matches /api/scorer-workflows
// (daemon: viewScorerWorkflows → { workflows: string[] })
// ---------------------------------------------------------------------------

const scorerWorkflowsResponseSchema = z.object({
  workflows: z.array(z.string()),
})

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

interface ScorerWorkflowsState {
  data: string[] | undefined
  isLoading: boolean
  error: Error | null
}

/**
 * Fetches the list of distinct workflow kinds that have at least one recorded
 * scorer result.
 *
 * Hits GET /api/scorer-workflows which the UI server proxies to the daemon's
 * /view/scorer-workflows endpoint.
 */
export const useScorerWorkflows = (): ScorerWorkflowsState => {
  const query = useQuery({
    queryKey: ['scorer-workflows'],
    queryFn: async () => {
      const res = await fetch('/api/scorer-workflows')
      if (!res.ok) throw new Error(`GET /api/scorer-workflows → ${res.status}`)
      const raw: unknown = await res.json()
      return scorerWorkflowsResponseSchema.parse(raw)
    },
  })

  return {
    data: query.data?.workflows,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
