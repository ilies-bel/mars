import { useQuery } from '@tanstack/react-query'
import { fetchKpis } from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import type { Kpi } from './types'

interface KpisState {
  data: Kpi[] | undefined
  isLoading: boolean
  error: Error | null
}

export const useKpis = (): KpisState => {
  const projectId = useFocusedProjectId()
  const query = useQuery({
    queryKey: ['kpis', projectId],
    queryFn: () => fetchKpis(projectId ?? undefined),
    enabled: projectId !== null,
  })

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
