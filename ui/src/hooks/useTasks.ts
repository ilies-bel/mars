import { useQuery } from '@tanstack/react-query'
import { fetchTasks } from '@/lib/api'
import { groupTasks } from '@/lib/group'
import { useSseConnected } from '@/lib/sseStatus'
import type { Snapshot } from '@/lib/types'

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
