import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchProgress } from '@/shared/api'
import { useSseConnected } from '@/shared/sseStatus'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { Cluster, ProgressProposalNode, ProgressTask } from '@/shared/schemas'

interface Aggregates {
  doneToday: number
  doneTotal: number
  failedOpen: number
}

interface State {
  tasks: ProgressTask[] | null
  proposals: ProgressProposalNode[]
  byCluster: Record<Cluster, ProgressTask[]>
  aggregates: Aggregates
  error: Error | null
  connected: boolean
}

const emptyByCluster = (): Record<Cluster, ProgressTask[]> => ({
  Queued: [],
  'In progress': [],
  Blocked: [],
  Failed: [],
  Done: [],
})

export const useProgress = (): State => {
  const { focusedProjectId: projectId } = useFocusedProject()
  const connected = useSseConnected()
  // Always fire — projectId ?? undefined drops the ?project= filter when no
  // project is selected, letting the server's --repo default answer. Keeping
  // `enabled` unconditional ensures the board renders on cold load without
  // waiting for the project registry to settle or for an SSE event to arrive.
  const query = useQuery({
    queryKey: ['progress', projectId],
    queryFn: ({ signal }) => fetchProgress(projectId ?? undefined, signal),
  })

  const tasks = query.data?.tasks ?? null
  const proposals = query.data?.proposals ?? []
  const aggregates: Aggregates = query.data?.aggregates ?? { doneToday: 0, doneTotal: 0, failedOpen: 0 }

  const byCluster = useMemo(() => {
    const clusters = emptyByCluster()
    if (tasks) {
      for (const t of tasks) {
        clusters[t.cluster].push(t)
      }
      const byUpdatedDesc = (a: ProgressTask, b: ProgressTask): number =>
        b.updatedAt.localeCompare(a.updatedAt)
      clusters.Queued.sort(byUpdatedDesc)
      clusters['In progress'].sort(byUpdatedDesc)
      clusters.Blocked.sort(byUpdatedDesc)
      clusters.Failed.sort(byUpdatedDesc)
    }
    return clusters
  }, [tasks])

  const error = query.error ?? null

  return { tasks, proposals, byCluster, aggregates, error, connected }
}
