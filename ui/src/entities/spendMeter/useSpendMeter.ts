import { useQuery } from '@tanstack/react-query'
import { fetchBudgetStatus } from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { BudgetStatus } from '@/shared/schemas'

interface SpendMeterState {
  data: BudgetStatus | undefined
  isLoading: boolean
  error: Error | null
}

/**
 * The daemon's spend sweep re-evaluates every ~30s; polling at the same
 * cadence keeps the tile within one sweep tick of the daemon's view.
 */
const POLL_MS = 30_000

/**
 * Poll the spend-meter status (GET /api/budget → daemon GET /budget).
 * An unconfigured meter returns `configured: false` — consumers render a
 * quiet "not configured" state, never a fake zero.
 */
export const useSpendMeter = (): SpendMeterState => {
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } =
    useFocusedProject()
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const query = useQuery({
    queryKey: ['spend-meter', projectId],
    queryFn: () => fetchBudgetStatus(projectId ?? undefined),
    enabled: projectId !== null || projectsEmpty,
    refetchInterval: POLL_MS,
  })

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}

/**
 * The set of arc ids currently over the per-arc ceiling — the join key for
 * the worker-sessions overview badge (sessions carry `arcId`).
 */
export const useOverCeilingArcIds = (): Set<string> => {
  const { data } = useSpendMeter()
  const over = new Set<string>()
  for (const arc of data?.arcs?.liveArcs ?? []) {
    if (arc.overCeiling) over.add(arc.arcId)
  }
  return over
}
