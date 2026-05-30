import { useQuery } from '@tanstack/react-query'
import { fetchTodo } from '@/shared/api'
import { useSseConnected } from '@/shared/sseStatus'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import type { DraftFeature, StaleWorktree } from './types'

interface State {
  drafts: DraftFeature[]
  staleWorktrees: StaleWorktree[]
  error: string | null
  connected: boolean
}

export const useTodo = (): State => {
  const projectId = useFocusedProjectId()
  const connected = useSseConnected()
  const query = useQuery({
    queryKey: ['todo', projectId],
    queryFn: () => fetchTodo(projectId ?? undefined),
    enabled: projectId !== null,
  })

  const drafts = query.data?.drafts ?? []
  const staleWorktrees = query.data?.staleWorktrees ?? []
  const error = query.error ? (query.error as Error).message : null

  return { drafts, staleWorktrees, error, connected }
}
