import { useQuery } from '@tanstack/react-query'
import { fetchProposalsPayload } from '@/shared/api'
import { useSseConnected } from '@/shared/sseStatus'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { DraftFeature } from '@/shared/schemas'

interface State {
  proposals: DraftFeature[]
  isPending: boolean
  error: string | null
  connected: boolean
}

export const useProposals = (): State => {
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()
  const connected = useSseConnected()
  // Fire without ?project= when the registry is empty so the server's --repo
  // default can answer.
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const query = useQuery({
    queryKey: ['proposals', projectId],
    // Request only draft proposals with an explicit limit so the server does
    // not return the full unfiltered table on every load.
    queryFn: () => fetchProposalsPayload(projectId ?? undefined, { status: 'draft', limit: 50 }),
    enabled: projectId !== null || projectsEmpty,
  })

  const proposals = query.data?.drafts ?? []
  const error = query.error ? (query.error as Error).message : null

  return { proposals, isPending: query.isPending, error, connected }
}
