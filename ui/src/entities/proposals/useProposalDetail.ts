import { useQuery } from '@tanstack/react-query'
import { fetchProposalDetail } from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { ProposalDetail } from '@/shared/schemas'

interface State {
  proposal: ProposalDetail | null
  isPending: boolean
}

/**
 * Fetch a single proposal by id from GET /api/proposals/:id. The query is
 * enabled only when `proposalId` is non-null, so callers can pass null to skip
 * the fetch (e.g. when no proposal hash is in the URL). The cached result
 * survives route switches — React Query deduplates with the same key.
 */
export const useProposalDetail = (proposalId: string | null): State => {
  const { focusedProjectId: projectId } = useFocusedProject()
  const query = useQuery({
    queryKey: ['proposal-detail', proposalId, projectId],
    queryFn: () => fetchProposalDetail(proposalId!, projectId ?? undefined),
    enabled: proposalId !== null,
  })
  return {
    proposal: query.data ?? null,
    isPending: query.isPending && proposalId !== null,
  }
}
