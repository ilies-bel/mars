import { useQuery } from '@tanstack/react-query'
import { fetchActionQueue } from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import type { ActionQueueItem } from '@/shared/schemas'

interface State {
  items: ActionQueueItem[]
  error: string | null
}

export const useActionQueue = (): State => {
  const projectId = useFocusedProjectId()
  const query = useQuery({
    queryKey: ['action-queue', projectId],
    queryFn: () => fetchActionQueue(projectId ?? undefined),
    enabled: projectId !== null,
  })

  return {
    items: query.data ?? [],
    error: query.error ? (query.error as Error).message : null,
  }
}
