import { fetchProposalsPayload } from '@/shared/api'
import type { DraftFeature } from '@/shared/schemas'

export const fetchProposals = async (
  projectId?: string,
  opts?: { source?: string; status?: string; limit?: number; cursor?: string | null },
): Promise<DraftFeature[]> => {
  const payload = await fetchProposalsPayload(projectId, opts)
  return payload.drafts
}
