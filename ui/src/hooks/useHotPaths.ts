import { useQuery } from '@tanstack/react-query'
import { fetchHotPaths } from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { HotPathsResponse } from '@/shared/schemas'

export interface UseHotPathsOptions {
  window: '30d' | '90d' | 'all'
  group: 'file' | 'dir'
}

export interface UseHotPathsResult {
  data: HotPathsResponse | undefined
  isLoading: boolean
  error: Error | null
}

export const useHotPaths = (opts: UseHotPathsOptions): UseHotPathsResult => {
  const { focusedProjectId: projectId } = useFocusedProject()
  const query = useQuery({
    queryKey: ['hot-paths', opts.window, opts.group, projectId],
    queryFn: ({ signal }) =>
      fetchHotPaths({ window: opts.window, group: opts.group, projectId: projectId ?? undefined }, signal),
  })
  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error ?? null,
  }
}
