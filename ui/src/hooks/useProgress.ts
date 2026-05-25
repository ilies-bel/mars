import { useQuery } from '@tanstack/react-query'
import { fetchProgress } from '@/shared/api'
import { useSseConnected } from '@/shared/sseStatus'
import type { Cluster, ProgressTask } from '@/shared/schemas'

interface State {
  tasks: ProgressTask[] | null
  byCluster: Record<Cluster, ProgressTask[]>
  error: string | null
  connected: boolean
}

const emptyByCluster = (): Record<Cluster, ProgressTask[]> => ({
  Queued: [],
  'In progress': [],
  Blocked: [],
  Failed: [],
})

export const useProgress = (): State => {
  const connected = useSseConnected()
  const query = useQuery({
    queryKey: ['progress'],
    queryFn: fetchProgress,
  })

  const tasks = query.data ?? null
  const byCluster = emptyByCluster()
  if (tasks) {
    for (const t of tasks) {
      byCluster[t.cluster].push(t)
    }
    const byUpdatedDesc = (a: ProgressTask, b: ProgressTask): number =>
      b.updatedAt.localeCompare(a.updatedAt)
    byCluster.Queued.sort(byUpdatedDesc)
    byCluster['In progress'].sort(byUpdatedDesc)
    byCluster.Blocked.sort(byUpdatedDesc)
    byCluster.Failed.sort(byUpdatedDesc)
  }

  const error = query.error ? (query.error as Error).message : null

  return { tasks, byCluster, error, connected }
}
