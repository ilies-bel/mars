import { useQuery } from '@tanstack/react-query'
import { fetchProposalsPayload } from '@/shared/api'
import { useSseConnected } from '@/shared/sseStatus'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { DraftFeature } from '@/shared/schemas'

interface State {
  /** The current page of drafts — capped by the `limit` below, so this is a
   *  page, NOT the full population. Never render `proposals.length` as a
   *  count of "how many drafts await review"; use `total` for that. */
  proposals: DraftFeature[]
  /**
   * Total drafts matching the request filters BEFORE pagination, as reported
   * by the daemon. This — not `proposals.length` — is the canonical "drafts
   * awaiting review" count, and it is the same population the triage page's
   * `draft-proposal` cluster row reports. Rendering the page length instead
   * silently capped the Proposals page badge at the fetch limit, which is how
   * that badge and the triage row came to show different numbers for one
   * concept.
   */
  total: number
  isPending: boolean
  /** The raw query error object; null when there is no error. */
  error: Error | null
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
  // Fall back to the page length only when the daemon omitted `total` (an
  // older daemon); a truncated count still beats reporting zero.
  const total = query.data?.total ?? proposals.length
  const error = (query.error as Error | null) ?? null

  return { proposals, total, isPending: query.isPending, error, connected, refetch: query.refetch }
}
