import { useQuery } from '@tanstack/react-query'
import { fetchTodo } from '@/shared/api'
import { useSseConnected } from '@/shared/sseStatus'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { DraftFeature } from '@/shared/schemas'

interface State {
  proposals: DraftFeature[]
  error: string | null
  connected: boolean
}

export const useProposals = (): State => {
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()
  const connected = useSseConnected()
  // Fire without ?project= when the registry is empty so the server's --repo
  // default can answer (same behaviour as useTodo).
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const query = useQuery({
    queryKey: ['todo', projectId],
    queryFn: () => fetchTodo(projectId ?? undefined),
    enabled: projectId !== null || projectsEmpty,
  })

  const proposals = query.data?.drafts ?? []
  const error = query.error ? (query.error as Error).message : null

  return { proposals, error, connected }
}
