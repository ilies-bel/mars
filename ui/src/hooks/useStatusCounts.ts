/**
 * useStatusCounts — shared hook for the four canonical operational counts.
 *
 * Fetches from GET /api/status-counts (→ daemon /view/status-counts) so that
 * every UI surface that renders running/recovering/needYou/failed/doneToday
 * uses the same server-side source instead of computing per-page.
 *
 * Returns zeros on first load or when the daemon is unreachable so components
 * can render without null checks.
 */
import { useQuery } from '@tanstack/react-query'
import { fetchStatusCounts } from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { StatusCounts } from '@/shared/schemas'

const EMPTY: StatusCounts = {
  running: 0,
  recovering: 0,
  needYou: 0,
  failed: 0,
  doneToday: 0,
}

export const useStatusCounts = (): StatusCounts => {
  const { focusedProjectId: projectId } = useFocusedProject()
  const query = useQuery({
    queryKey: ['status-counts', projectId],
    queryFn: ({ signal }) => fetchStatusCounts(projectId ?? undefined, signal),
  })
  return query.data ?? EMPTY
}
