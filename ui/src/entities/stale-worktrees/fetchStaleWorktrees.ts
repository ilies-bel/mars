import { fetchStaleWorktreesPayload } from '@/shared/api'
import type { StaleWorktree } from '@/shared/schemas'

export const fetchStaleWorktrees = async (projectId?: string): Promise<StaleWorktree[]> => {
  const payload = await fetchStaleWorktreesPayload(projectId)
  return payload.staleWorktrees
}
