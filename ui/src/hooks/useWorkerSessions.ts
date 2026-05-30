import { useQuery } from '@tanstack/react-query'
import { fetchWorkerSessions } from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import type { WorkerSession } from '@/shared/schemas'

interface State {
  sessions: WorkerSession[] | null
  error: string | null
}

/** How often to re-fetch sessions to pick up live → terminal transitions. */
const LIVE_POLL_MS = 5_000

export const useWorkerSessions = (agentName: string | null): State => {
  const projectId = useFocusedProjectId()
  const query = useQuery({
    queryKey: ['sessions', projectId, agentName],
    queryFn: () =>
      agentName
        ? fetchWorkerSessions(agentName, projectId ?? undefined)
        : Promise.resolve([]),
    enabled: agentName !== null && projectId !== null,
    refetchInterval: LIVE_POLL_MS,
  })

  const sessions = query.data ?? null
  const error = query.error ? (query.error as Error).message : null

  return { sessions, error }
}
