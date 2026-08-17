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
  refetch: () => void
}

export const useProposals = (): State => {
  const { focusedProjectId: projectId, projectsSettled } = useFocusedProject()
  const connected = useSseConnected()
  // Fire once the project registry has settled (success, error, or empty) so
  // the server's --repo default can answer when no project is resolved.
  // Also fire immediately when a stored project ID is already available.
  const query = useQuery({
    queryKey: ['proposals', projectId],
    // Request only draft proposals with an explicit limit so the server does
    // not return the full unfiltered table on every load.
    queryFn: () => fetchProposalsPayload(projectId ?? undefined, { status: 'draft', limit: 50 }),
    enabled: projectId !== null || projectsSettled,
    // SchemaErrors indicate a version skew between the UI bundle and the
    // running daemon; retrying won't fix them.  Surface the error immediately
    // (no retry) so the operator sees "Failed to load proposals" instead of
    // "Loading…" indefinitely while the retry backoff drains.
    // Check by name to avoid importing SchemaError into test-mocked modules.
    retry: (failureCount, error) => {
      if ((error as { name?: string } | null)?.name === 'SchemaError') return false
      return failureCount < 1
    },
  })

  const proposals = query.data?.drafts ?? []
  const error = query.error ? (query.error as Error).message : null

  return { proposals, isPending: query.isPending, error, connected, refetch: query.refetch }
}
