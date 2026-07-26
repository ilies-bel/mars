/**
 * StudioPage — the full-page Studio surface at `#/studio/<taskId>`.
 *
 * A first-class route (not another drawer section): the live execution tree
 * for one task's workflow runs, reachable from the task drawer's step
 * timeline ("Open in Studio →"). Read-only projection; the page fetches the
 * run timeline via useStudio and stays live through the existing
 * SSE-invalidation loop (see useStudio for the query-key contract).
 */

import { useEffect } from 'react'
import { useStudio } from '@/entities/studio/useStudio'
import { StudioView } from '@/widgets/StudioView'
import { FallbackSurface } from '@/components/FallbackSurface'
import { SkeletonBlock } from '@/components/Skeleton'
import { setOpenTaskId } from '@/shared/openTaskId'
import { taskHash } from '@/shared/routing'

export interface StudioPageProps {
  /** Task id parsed from `#/studio/<taskId>`. */
  taskId: string
  /** Override the fetcher in tests. Production callers omit it. */
  fetchImpl?: typeof fetch
}

export const StudioPage = ({ taskId, fetchImpl }: StudioPageProps) => {
  // Register as the open task so SseInvalidator's `['task', openId]`
  // invalidation retargets this page's queries on every SSE 'tasks' event —
  // the same mechanism that keeps the task drawer live.
  useEffect(() => {
    setOpenTaskId(taskId)
    return () => setOpenTaskId(null)
  }, [taskId])

  const { timeline, isLoading, error } = useStudio(taskId, fetchImpl)

  return (
    <div data-testid="studio-page" className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header bar — mirrors KpiDetailPage's back-link pattern. */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-primary/20 px-4 py-3">
        <a
          href={taskHash(taskId)}
          data-testid="studio-back-to-task"
          className="text-sm text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          aria-label={`Back to task ${taskId}`}
        >
          ← Task
        </a>
        <span className="text-muted-foreground" aria-hidden="true">
          |
        </span>
        <span className="font-mono text-sm font-semibold uppercase tracking-wide text-foreground">
          Studio
        </span>
        <span className="break-all font-mono text-xs text-muted-foreground">{taskId}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <div aria-busy="true" aria-label="Loading run timeline" className="flex flex-col gap-3">
            <SkeletonBlock className="h-4 w-1/3" />
            <SkeletonBlock className="h-16 w-full" />
            <SkeletonBlock className="h-16 w-full" />
          </div>
        ) : error !== null ? (
          <FallbackSurface error={error} of="the run timeline" variant="pane" />
        ) : timeline !== undefined ? (
          <StudioView taskId={taskId} timeline={timeline} fetchImpl={fetchImpl} />
        ) : null}
      </div>
    </div>
  )
}
