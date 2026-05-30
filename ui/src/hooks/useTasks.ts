import { useQuery } from '@tanstack/react-query'
import { fetchTasks } from '@/shared/api'
import { groupTasks } from '@/shared/group'
import { useSseConnected } from '@/shared/sseStatus'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { Snapshot } from '@/shared/types'

interface State {
  snapshot: Snapshot | null
  error: string | null
  connected: boolean
}

export const useTasks = (): State => {
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()
  const connected = useSseConnected()
  // Option (a) fallback: fire without ?project= when registry is empty so the
  // server's --repo default can answer.
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const query = useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => fetchTasks(projectId ?? undefined),
    enabled: projectId !== null || projectsEmpty,
  })

  const snapshot = query.data ? groupTasks(query.data) : null
  const error = query.error ? (query.error as Error).message : null

  return { snapshot, error, connected }
}
