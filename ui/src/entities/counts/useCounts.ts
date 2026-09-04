/**
 * useCounts — single source of truth for all count numbers shown across the UI.
 *
 * Fetches from GET /api/counts (→ daemon /view/counts) so that the sidebar
 * badge, board header, Control Room Now-strip, chat greeting, and proposals
 * header all display the same numbers without each widget computing its own
 * count from a different endpoint.
 *
 * Returns zeros while the first fetch is in flight or when the daemon is
 * unreachable, and reports `known: false` in those cases so components can
 * distinguish "zero items" from "count unknown". A confident all-clear over a
 * failed fetch (showing "All quiet." while fifteen items need attention) is a
 * worse failure mode than showing nothing.
 */
import { useQuery } from '@tanstack/react-query'
import { fetchCounts } from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { Counts } from '@/shared/schemas'

const EMPTY: Counts = {
  needsYou: 0,
  running: 0,
  verifying: 0,
  merging: 0,
  queued: 0,
  blocked: 0,
  failed: 0,
  doneToday: 0,
  proposals: { draft: 0, total: 0 },
}

export interface CountsState extends Counts {
  /**
   * True once the counts reflect a real answer from the daemon. False while
   * the first fetch is in flight and false when it failed — in both cases the
   * zeros above are placeholders, not measurements.
   */
  known: boolean
}

export const useCounts = (): CountsState => {
  const { focusedProjectId: projectId } = useFocusedProject()
  const query = useQuery({
    queryKey: ['counts', projectId],
    queryFn: ({ signal }) => fetchCounts(projectId ?? undefined, signal),
  })
  return { ...(query.data ?? EMPTY), known: query.data !== undefined }
}
