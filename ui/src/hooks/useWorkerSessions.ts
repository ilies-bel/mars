import { useQuery } from '@tanstack/react-query'
import { fetchWorkerSessions } from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import { useOverCeilingArcIds } from '@/entities/spendMeter/useSpendMeter'
import type { WorkerSession } from '@/shared/schemas'

/**
 * A worker session decorated with the spend-meter join: `arcOverCeiling` is
 * true when the session's arc is currently over the configured per-arc
 * token ceiling (an open 'budget-arc' condition). Always false when the
 * meter is unconfigured or the session carries no arc attribution — the
 * agent overview renders a warning badge off this flag.
 */
export interface WorkerSessionWithBudget extends WorkerSession {
  arcOverCeiling: boolean
}

interface State {
  sessions: WorkerSessionWithBudget[] | null
  error: string | null
}

/** How often to re-fetch sessions to pick up live → terminal transitions. */
const LIVE_POLL_MS = 5_000

export const useWorkerSessions = (agentName: string | null): State => {
  const projectId = useFocusedProjectId()
  const overCeilingArcIds = useOverCeilingArcIds()
  const query = useQuery({
    queryKey: ['sessions', projectId, agentName],
    queryFn: () =>
      agentName
        ? fetchWorkerSessions(agentName, projectId ?? undefined)
        : Promise.resolve([]),
    enabled: agentName !== null && projectId !== null,
    refetchInterval: LIVE_POLL_MS,
  })

  const sessions = query.data
    ? query.data.map((s) => ({
        ...s,
        arcOverCeiling: s.arcId !== null && overCeilingArcIds.has(s.arcId),
      }))
    : null
  const error = query.error ? (query.error as Error).message : null

  return { sessions, error }
}
