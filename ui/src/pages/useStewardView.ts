import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { appendProject, fetchJson } from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'

// ---------------------------------------------------------------------------
// Schema — matches GET /view/steward
// ---------------------------------------------------------------------------

const AckSchema = z.object({
  text: z.string(),
  timestamp: z.string(),
  pair: z.object({ from: z.number(), to: z.number() }).nullable(),
})

export const StewardViewSchema = z.object({
  runtimeTuning: z.object({
    acks: z.array(AckSchema),
    liveCap: z.number(),
    baselineCap: z.number(),
    ceiling: z.number(),
    bumpFactor: z.number(),
    thresholdFactor: z.number(),
    sustainMs: z.number(),
    checkMs: z.number(),
  }),
  workflowPatches: z.object({
    rows: z.array(z.object({
      id: z.string(),
      workflow_path: z.string(),
      unified_diff: z.string(),
      rationale: z.string(),
      status: z.string(),
      created_at: z.string(),
    })),
    hasCallers: z.boolean(),
  }),
  signatureStorm: z.object({
    current_signature: z.string().nullable(),
    streak_count: z.number(),
    last_task_id: z.string().nullable(),
    tripped: z.boolean(),
    updated_at: z.string().nullable(),
    signatureStormAqCount: z.number(),
    tripThreshold: z.number(),
    isPaused: z.boolean(),
  }),
  agentSpec: z.object({
    name: z.string(),
    model: z.string(),
    allowedTools: z.array(z.string()),
    eventVariants: z.array(z.string()),
    dispatchSites: z.number(),
  }),
})

export type StewardView = z.infer<typeof StewardViewSchema>

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
