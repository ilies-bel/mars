import { useQuery } from '@tanstack/react-query'
import { fetchAgents } from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import type { Agent } from '@/shared/schemas'

interface State {
  agents: Agent[] | null
  error: string | null
}

export const useAgents = (): State => {
  const projectId = useFocusedProjectId()
  const query = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => fetchAgents(projectId ?? undefined),
    enabled: projectId !== null,
  })

  const agents = query.data ?? null
  const error = query.error ? (query.error as Error).message : null

  return { agents, error }
}
