import { useQuery } from '@tanstack/react-query'
import { fetchActionQueue } from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { ActionQueueItem, ActionQueueGroupRow } from '@/shared/schemas'

interface State {
  items: ActionQueueItem[]
  /**
   * Server-pre-grouped cause rows from the wire envelope (HR-3).
   * Each entry represents N items sharing the same (kind, signature) that the
   * server already collapsed into one group row. Consumers pass these to
   * `buildRenderedRows` and `countNeedsYou` so the UI and CLI show the same
   * count and cause label. Optional for backward compat with mocks that predate
   * this field.
   */
  serverGroups?: ActionQueueGroupRow[]
  error: Error | null
  /**
   * True while the query's first fetch is still in flight (no cached data
   * yet). Callers that render an empty-vs-error distinction from `items`
   * and `error` alone conflate "still loading" with "genuinely empty" —
   * this lets them show a loading state instead. Optional so existing
   * mocks that predate this field keep compiling.
   */
  isPending?: boolean
  /**
   * The error thrown by GET /api/projects, if the projects query failed.
   * null while loading or when projects loaded successfully.
   * When this is an ApiError with kind='stale-daemon', the UI server predates
   * the /api/projects route — surface a "restart the mars-ui server" hint.
   */
  projectsError: Error | null
  /**
   * True when GET /api/projects succeeded but returned zero projects.
   * In this case the hook still fires fetchActionQueue without a ?project=
   * param so the server-side --repo default can answer (option a fallback).
   * Consumers should render an actionable "no projects registered" message
   * when this is true AND items is empty.
   */
  projectsEmpty: boolean
}

export const useActionQueue = (): State => {
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()

  // Option (a) fallback: when projects loaded successfully but zero are
  // registered, fire the query WITHOUT a ?project= param so the server's
  // --repo default can answer.  This restores single-repo behaviour.
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const enabled = projectId !== null || projectsEmpty

  const query = useQuery({
    queryKey: ['action-queue', projectId],
    queryFn: () => fetchActionQueue(projectId ?? undefined),
    enabled,
    // Polling safety net: a recovered/superseded row clears within ~15 s even
    // when SSE events are missed (network blip, reconnect delay).
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  })

  // Split the wire rows into flat items (type:'item' → .row) and server-pre-grouped
  // cause rows (type:'group'). Consumers use items for display and bulk actions;
  // serverGroups flow to buildRenderedRows/countNeedsYou for the triage view.
  const wireRows = query.data ?? []
  const items = wireRows.flatMap((r) => r.type === 'item' ? [r.row] : [])
  const serverGroups = wireRows.flatMap((r) => r.type === 'group' ? [r] : [])

  return {
    items,
    serverGroups,
    error: (query.error as Error | null) ?? null,
    isPending: enabled && query.isPending,
    projectsError,
    projectsEmpty,
  }
}
