import { useQuery } from '@tanstack/react-query'
import { fetchProgress } from '@/shared/api'
import { useSseConnected } from '@/shared/sseStatus'
import type { Cluster, ProgressProposalNode, ProgressTask } from '@/shared/schemas'

interface State {
  tasks: ProgressTask[] | null
  proposals: ProgressProposalNode[]
  byCluster: Record<Cluster, ProgressTask[]>
  error: string | null
  connected: boolean
}

interface UseProgressOptions {
  /**
   * Recency window for the Failed cluster in milliseconds. `null` means "all"
   * (no cutoff). `undefined` uses the server default (24h). Changing this
   * value re-fetches /api/progress with an updated ?failedWindow parameter.
   */
  failedWindowMs?: number | null
}

const emptyByCluster = (): Record<Cluster, ProgressTask[]> => ({
  Queued: [],
  'In progress': [],
  Blocked: [],
  Failed: [],
})

export const useProgress = (options: UseProgressOptions = {}): State => {
  const { failedWindowMs } = options
  const connected = useSseConnected()
  const query = useQuery({
    queryKey: ['progress', failedWindowMs ?? 'default'],
    queryFn: () => fetchProgress(failedWindowMs),
  })

  const tasks = query.data?.tasks ?? null
  const proposals = query.data?.proposals ?? []
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

  return { tasks, proposals, byCluster, error, connected }
}
