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

export const useKpiArcs = (key: KpiKey): KpiArcsState => {
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const query = useQuery({
    queryKey: ['kpi-arcs', key, projectId],
    queryFn: () => fetchKpiArcs(key, projectId ?? undefined),
    enabled: projectId !== null || projectsEmpty,
  })

  return {
    data: query.data,
    arcs: query.data?.arcs ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
