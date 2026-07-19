import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Server response schema — matches what /view/workflow-configs returns
// (daemon: viewWorkflowConfigs → { configs: WorkflowConfig[] })
// ---------------------------------------------------------------------------

const workflowConfigSchema = z.object({
  id: z.string(),
  version: z.number(),
  createdAt: z.string(),
  // Accept the full backend status set; the hook interface narrows to the
  // frontend contract ('active' | 'trial' | 'retired').
  status: z.string(),
})

const workflowConfigsResponseSchema = z.object({
  configs: z.array(workflowConfigSchema),
})

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface WorkflowConfig {
  id: string
  version: number
  createdAt: string
  status: 'active' | 'trial' | 'retired'
}

export interface WorkflowConfigsState {
  configs: WorkflowConfig[]
  isLoading: boolean
  error: Error | null
}

/**
 * Fetches versioned config records for a single workflow kind.
 *
 * Hits GET /api/workflow-configs?workflow=<kind> which the UI dev-server
 * proxies to the daemon's /view/workflow-configs endpoint.
 */
export const useWorkflowConfigs = (workflow: string): WorkflowConfigsState => {
  const query = useQuery({
    queryKey: ['workflow-configs', workflow],
    queryFn: async () => {
      const res = await fetch(
        `/api/workflow-configs?workflow=${encodeURIComponent(workflow)}`,
      )
      if (!res.ok) throw new Error(`GET /api/workflow-configs → ${res.status}`)
      const raw: unknown = await res.json()
      return workflowConfigsResponseSchema.parse(raw)
    },
  })

  return {
    configs: (query.data?.configs ?? []) as WorkflowConfig[],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
