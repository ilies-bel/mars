import { useQuery } from '@tanstack/react-query'
import { fetchCostPerMergedTask } from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { CostPerMergedTaskResponse } from '@/shared/schemas'

interface CostPerMergedTaskState {
  data: CostPerMergedTaskResponse | undefined
  isLoading: boolean
  error: Error | null
}

export const useCostPerMergedTask = (days = 30): CostPerMergedTaskState => {
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const query = useQuery({
    queryKey: ['cost-per-merged-task', days, projectId],
    queryFn: () => fetchCostPerMergedTask(days, projectId ?? undefined),
    enabled: projectId !== null || projectsEmpty,
  })

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
