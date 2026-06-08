import { useQuery } from '@tanstack/react-query'
import { fetchStaleWorktreesPayload } from '@/shared/api'
import { useSseConnected } from '@/shared/sseStatus'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { StaleWorktree } from '@/shared/schemas'

interface State {
  staleWorktrees: StaleWorktree[]
  error: string | null
  connected: boolean
}

export const useStaleWorktrees = (): State => {
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()
  const connected = useSseConnected()
  // Fire without ?project= when the registry is empty so the server's --repo
  // default can answer.
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const query = useQuery({
    queryKey: ['stale-worktrees', projectId],
    queryFn: () => fetchStaleWorktreesPayload(projectId ?? undefined),
    enabled: projectId !== null || projectsEmpty,
  })

  const staleWorktrees = query.data?.staleWorktrees ?? []
  const error = query.error ? (query.error as Error).message : null

  return { staleWorktrees, error, connected }
}
