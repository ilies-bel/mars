import { useQuery } from '@tanstack/react-query'
import { fetchActionQueue } from '@/shared/api'
import type { ActionQueueItem } from '@/shared/schemas'

interface State {
  items: ActionQueueItem[]
  error: string | null
}

export const useActionQueue = (): State => {
  const query = useQuery({
    queryKey: ['action-queue'],
    queryFn: fetchActionQueue,
  })

  return {
    items: query.data ?? [],
    error: query.error ? (query.error as Error).message : null,
  }
}
