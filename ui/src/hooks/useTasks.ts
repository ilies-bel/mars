import { useQuery } from '@tanstack/react-query'
import { fetchTasks } from '@/shared/api'
import { groupTasks } from '@/shared/group'
import { useSseConnected } from '@/shared/sseStatus'
import type { Snapshot } from '@/shared/types'

interface State {
  snapshot: Snapshot | null
  error: string | null
  connected: boolean
}

export const useTasks = (): State => {
  const connected = useSseConnected()
  const query = useQuery({
    queryKey: ['tasks'],
    queryFn: fetchTasks,
  })

  const snapshot = query.data ? groupTasks(query.data) : null
  const error = query.error ? (query.error as Error).message : null

  return { snapshot, error, connected }
}
