import { useQuery } from '@tanstack/react-query'
import { fetchWorkerSessions } from '@/shared/api'
import type { WorkerSession } from '@/shared/schemas'

interface State {
  sessions: WorkerSession[] | null
  error: string | null
}

export const useWorkerSessions = (agentName: string | null): State => {
  const query = useQuery({
    queryKey: ['sessions', agentName],
    queryFn: () =>
      agentName ? fetchWorkerSessions(agentName) : Promise.resolve([]),
    enabled: agentName !== null,
  })

  const sessions = query.data ?? null
  const error = query.error ? (query.error as Error).message : null

  return { sessions, error }
}
