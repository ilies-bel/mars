import { fetchProposalsPayload } from '@/shared/api'
import type { DraftFeature } from '@/shared/schemas'

export const fetchProposals = async (projectId?: string): Promise<DraftFeature[]> => {
  const payload = await fetchProposalsPayload(projectId)
  return payload.drafts
}
