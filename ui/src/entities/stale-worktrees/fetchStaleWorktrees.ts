import { fetchTodo } from '@/shared/api'
import type { StaleWorktree } from '@/shared/schemas'

export const fetchStaleWorktrees = async (projectId?: string): Promise<StaleWorktree[]> => {
  const payload = await fetchTodo(projectId)
  return payload.staleWorktrees
}
