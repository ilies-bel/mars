import { useQuery } from '@tanstack/react-query'
import { fetchActionQueue } from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { ActionQueueItem } from '@/shared/schemas'

interface State {
  items: ActionQueueItem[]
  error: Error | null
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
  })

  return {
    items: query.data ?? [],
    error: (query.error as Error | null) ?? null,
    projectsError,
    projectsEmpty,
  }
}
