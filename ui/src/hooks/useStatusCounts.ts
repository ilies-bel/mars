/**
 * useStatusCounts — shared hook for the four canonical operational counts.
 *
 * Fetches from GET /api/status-counts (→ daemon /view/status-counts) so that
 * every UI surface that renders running/recovering/needYou/failed/doneToday
 * uses the same server-side source instead of computing per-page.
 *
 * Returns zeros on first load or when the daemon is unreachable so components
 * can render without null checks — but ALSO reports `known`, because zero and
 * unknown are not the same claim. With the daemon down every count reads zero,
 * and a caller that cannot tell the difference renders a confident all-clear
 * over a failed fetch. (Observed: the chat greeting said "All quiet." while
 * fifteen items needed attention and the API was unreachable.)
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

export interface StatusCountsState extends StatusCounts {
  /**
   * True once the counts reflect a real answer from the daemon. False while
   * the first fetch is in flight and false when it failed — in both cases the
   * zeros above are placeholders, not measurements.
   */
  known: boolean
}

export const useStatusCounts = (): StatusCountsState => {
  const { focusedProjectId: projectId } = useFocusedProject()
  const query = useQuery({
    queryKey: ['status-counts', projectId],
    queryFn: ({ signal }) => fetchStatusCounts(projectId ?? undefined, signal),
  })
  return { ...(query.data ?? EMPTY), known: query.data !== undefined }
}
