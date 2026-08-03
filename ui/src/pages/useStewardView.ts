import { useQuery } from '@tanstack/react-query'
import { appendProject, fetchJson } from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import { StewardViewSchema, type StewardView } from './steward-view-schema'

export { StewardViewSchema }
export type { StewardView }

// ---------------------------------------------------------------------------
// Schema — matches GET /view/steward
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface StewardViewState {
  data: StewardView | undefined
  isLoading: boolean
  error: Error | null
}

/**
 * Fetches the Steward capability overview from GET /api/steward.
 *
 * Returns four sections:
 *   - runtimeTuning  — the only lane that actually executes
 *   - workflowPatches — built, never invoked
 *   - signatureStorm  — live, may be currently tripped
 *   - agentSpec      — declared, never dispatched
 */
export const useStewardView = (): StewardViewState => {
  const projectId = useFocusedProjectId()
  const query = useQuery({
    queryKey: ['steward-view', projectId],
    queryFn: () =>
      fetchJson(appendProject('/api/steward', projectId ?? undefined), StewardViewSchema),
    // Refresh every 30s — signature storm state changes frequently.
    refetchInterval: 30_000,
  })

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
