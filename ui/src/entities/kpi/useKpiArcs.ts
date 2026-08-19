import { useQuery } from '@tanstack/react-query'
import { fetchKpiArcs } from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { KpiArc, KpiArcsResponse, KpiKey } from '@/shared/schemas'

interface KpiArcsState {
  data: KpiArcsResponse | undefined
  arcs: KpiArc[]
  isLoading: boolean
  error: Error | null
}

/**
 * KPI keys the daemon's `/kpis/:key/arcs` endpoint can break down per arc.
 *
 * `cost-per-merged-task` is measured per merged task per calendar day, not per
 * arc, and the daemon rejects it with 400 "Unknown KPI key". KpiDetailPage
 * calls this hook before its early return for that key (hooks cannot be
 * conditional), so without this gate every visit to the cost detail page fired
 * a request that was guaranteed to fail and whose result was discarded on the
 * next line.
 */
const KEYS_WITH_ARC_BREAKDOWN: ReadonlySet<KpiKey> = new Set<KpiKey>([
  'cost_per_arc',
  'failure_rate',
  'autonomous_completion_rate',
  'recovery_success_rate',
])

export const useKpiArcs = (key: KpiKey): KpiArcsState => {
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const query = useQuery({
    queryKey: ['kpi-arcs', key, projectId],
    queryFn: () => fetchKpiArcs(key, projectId ?? undefined),
    enabled: (projectId !== null || projectsEmpty) && KEYS_WITH_ARC_BREAKDOWN.has(key),
  })

  return {
    data: query.data,
    arcs: query.data?.arcs ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
