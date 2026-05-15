import { useQuery } from '@tanstack/react-query'
import { fetchAgents } from '../lib/api'
import type { Agent } from '../lib/schemas'

interface State {
  agents: Agent[] | null
  error: string | null
}

export const useAgents = (): State => {
  const query = useQuery({
    queryKey: ['agents'],
    queryFn: fetchAgents,
  })

  const agents = query.data ?? null
  const error = query.error ? (query.error as Error).message : null

  return { agents, error }
}
