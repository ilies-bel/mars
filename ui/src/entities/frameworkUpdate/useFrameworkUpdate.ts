import { useQuery } from '@tanstack/react-query'
import { fetchFrameworkUpdate } from '@/shared/api'
import type { FrameworkUpdate } from '@/shared/schemas'

interface State {
  update: FrameworkUpdate | null
  error: string | null
  /** True while the initial fetch is in flight (no data yet). */
  isPending: boolean
}

/**
 * Polls the daemon's framework-update view every 5 minutes.
 * No dedicated SSE channel exists for this; periodic polling is adequate
 * since updates are infrequent.
 */
export const useFrameworkUpdate = (): State => {
  const query = useQuery({
    queryKey: ['framework-update'],
    queryFn: fetchFrameworkUpdate,
    refetchInterval: 5 * 60 * 1000, // refetch every 5 minutes
    staleTime: 4 * 60 * 1000, // data is fresh for 4 minutes
  })

  return {
    update: query.data ?? null,
    error: query.error ? (query.error as Error).message : null,
    isPending: query.isPending,
  }
}
