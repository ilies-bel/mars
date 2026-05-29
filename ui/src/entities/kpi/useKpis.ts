import { useQuery } from '@tanstack/react-query'
import { fetchKpis } from '@/shared/api'
import type { Kpi } from './types'

interface KpisState {
  data: Kpi[] | undefined
  isLoading: boolean
  error: Error | null
}

export const useKpis = (): KpisState => {
  const query = useQuery({
    queryKey: ['kpis'],
    queryFn: fetchKpis,
  })

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
