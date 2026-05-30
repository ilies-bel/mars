import { useQuery } from '@tanstack/react-query'
import { fetchTodo } from '@/shared/api'
import { useSseConnected } from '@/shared/sseStatus'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { DraftFeature, StaleWorktree } from './types'

interface State {
  drafts: DraftFeature[]
  staleWorktrees: StaleWorktree[]
  error: string | null
  connected: boolean
}

export const useTodo = (): State => {
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()
  const connected = useSseConnected()
  // Option (a) fallback: fire without ?project= when registry is empty so the
  // server's --repo default can answer.
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const query = useQuery({
    queryKey: ['todo', projectId],
    queryFn: () => fetchTodo(projectId ?? undefined),
    enabled: projectId !== null || projectsEmpty,
  })

  const drafts = query.data?.drafts ?? []
  const staleWorktrees = query.data?.staleWorktrees ?? []
  const error = query.error ? (query.error as Error).message : null

  return { drafts, staleWorktrees, error, connected }
}
