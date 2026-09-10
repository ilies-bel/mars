import { ArrowLeft } from 'lucide-react'
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
import { useQuery } from '@tanstack/react-query'
import { useStudio } from '@/entities/studio/useStudio'
import { StudioView } from '@/widgets/StudioView'
import { FallbackSurface } from '@/components/FallbackSurface'
import { SkeletonBlock } from '@/components/Skeleton'
import { setOpenTaskId } from '@/shared/openTaskId'
import { taskHash } from '@/shared/routing'
import { PageHeader } from '@/widgets/primitives/DensityPrimitives'
import { taskSchema } from '@/shared/schemas'
import { taskTitle } from '@/shared/promptTitle'
import { useFocusedProject } from '@/shared/useFocusedProject'
import { useTaskScore } from '@/entities/watchtower/useTaskScore'
import { ScoreBar } from '@/components/ScoreBar'
import { relativeTime } from '@/shared/time'

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

  const { focusedProjectId: projectId } = useFocusedProject()
  // Fetch the task to show its human title in the header.
  // The data is typically already in the React Query cache from the task drawer
  // that linked here, so this resolves instantly without a new network request.
  const taskQuery = useQuery({
    queryKey: ['task', taskId],
    queryFn: async () => {
      const f = fetchImpl ?? fetch
      const res = await f(`/api/tasks/${encodeURIComponent(taskId)}`)
      if (!res.ok) return null
      const raw = (await res.json()) as { task: unknown }
      const parsed = taskSchema.safeParse(raw.task)
      return parsed.success ? parsed.data : null
    },
    enabled: projectId !== null,
    retry: false,
  })
  const task = taskQuery.data ?? null

  const { timeline, isLoading, error } = useStudio(taskId, fetchImpl)

  // The score is why the operator is here — this page is reached by clicking
  // one in the Scores table. It used to be dropped on arrival.
  const { entry: score, isLoading: scoreLoading } = useTaskScore(taskId)

  return (
    <div data-testid="studio-page" className="flex h-full flex-col overflow-hidden bg-background">
      <PageHeader
        title={task ? taskTitle(task) : 'Scores'}
        subtitle={taskId}
        actions={
          <a
            href={taskHash(taskId)}
            data-testid="studio-back-to-task"
            className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-label text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            <ArrowLeft size={13} strokeWidth={2} aria-hidden="true" />
            Back to task
          </a>
        }
        toolbar={
          scoreLoading ? null : (
            <div data-testid="studio-score" className="flex items-center gap-3">
              {score !== null && score.score !== null ? (
                <>
                  <ScoreBar score={score.score} size="lg" data-testid="studio-score-bar" />
                  <p className="text-label text-muted-foreground">
                    {score.recorded ? 'Scored' : 'Scored, not recorded'}
                    {score.scoredAt !== null ? ` ${relativeTime(score.scoredAt)}` : ''}
                  </p>
                </>
              ) : (
                <p className="text-label text-muted-foreground">
                  Not scored — this run has no scorer verdict.
                </p>
              )}
            </div>
          )
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <div aria-busy="true" aria-label="Loading run timeline" className="flex flex-col gap-3">
            <SkeletonBlock className="h-4 w-1/3" />
            <SkeletonBlock className="h-16 w-full" />
            <SkeletonBlock className="h-16 w-full" />
          </div>
        ) : error !== null ? (
          <FallbackSurface error={error} of="run timeline" variant="pane" />
        ) : timeline !== undefined ? (
          <StudioView taskId={taskId} timeline={timeline} fetchImpl={fetchImpl} />
        ) : null}
      </div>
    </div>
  )
}
