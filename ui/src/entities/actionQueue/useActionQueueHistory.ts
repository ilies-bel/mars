import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { fetchActionQueueHistory } from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import type { ActionQueueItem } from '@/shared/schemas'

interface State {
  items: ActionQueueItem[]
  nextCursor: string | null
  isLoadingMore: boolean
  loadMore: () => void
  error: Error | null
  projectsError: Error | null
  projectsEmpty: boolean
}

/**
 * Cursor-paged hook for resolved action-queue history rows.
 * Mirrors the focused-project / projectsEmpty fallback from useActionQueue.
 *
 * Usage:
 *   const { items, nextCursor, loadMore, isLoadingMore } = useActionQueueHistory()
 *
 * Call `loadMore()` when the user clicks "Load more". The hook accumulates
 * pages in memory (extraPages state) — no eviction.
 */
export const useActionQueueHistory = (): State => {
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()

  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const enabled = projectId !== null || projectsEmpty

  const [extraPages, setExtraPages] = useState<ActionQueueItem[][]>([])
  const [overrideCursor, setOverrideCursor] = useState<string | null | undefined>(undefined)

  const initial = useQuery({
    queryKey: ['action-queue-history', projectId],
    queryFn: () => fetchActionQueueHistory({ limit: 50 }, projectId ?? undefined),
    enabled,
  })

  const more = useMutation({
    mutationFn: (cursor: string) =>
      fetchActionQueueHistory({ cursor, limit: 50 }, projectId ?? undefined),
    onSuccess: (res) => {
      setExtraPages((p) => [...p, res.rows])
      setOverrideCursor(res.nextCursor)
    },
  })

  const items = [(initial.data?.rows ?? []), ...extraPages].flat()
  const nextCursor =
    overrideCursor === undefined
      ? (initial.data?.nextCursor ?? null)
      : overrideCursor

  const loadMore = () => {
    if (nextCursor && !more.isPending) {
      more.mutate(nextCursor)
    }
  }

  return {
    items,
    nextCursor,
    isLoadingMore: more.isPending,
    loadMore,
    error: (initial.error as Error | null) ?? null,
    projectsError,
    projectsEmpty,
  }
}
