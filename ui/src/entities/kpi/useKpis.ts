import { useQuery } from '@tanstack/react-query'
import { fetchKpis } from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { Kpi } from './types'

interface KpisState {
  data: Kpi[] | undefined
  isLoading: boolean
  error: Error | null
}

export const useKpis = (): KpisState => {
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()
  // Option (a) fallback: fire without ?project= when registry is empty so the
  // server's --repo default can answer.
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const query = useQuery({
    queryKey: ['kpis', projectId],
    queryFn: () => fetchKpis(projectId ?? undefined),
    enabled: projectId !== null || projectsEmpty,
  })

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
