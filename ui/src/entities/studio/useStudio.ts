/**
 * Studio hooks — React Query wrappers over the studio api module.
 *
 * Query keys deliberately live under the `['task', taskId, …]` prefix (the
 * same family the task drawer uses):
 *
 * - `['task', taskId, 'runs']` is the EXACT key the drawer's run-timeline
 *   query uses, so React Query deduplicates the fetch when both surfaces are
 *   mounted, and the existing SseInvalidator pattern — `invalidateQueries({
 *   queryKey: ['task', openId] })` on every SSE 'tasks' event — refreshes
 *   Studio live with zero new invalidation wiring. The screen is the state.
 *
 * - `['task', taskId, 'step-prompt', runId, stepName]` nests the lazily
 *   fetched per-step prompt under the same prefix for the same reason.
 */

import { useQuery } from '@tanstack/react-query'
import type { RunTimeline } from '@/widgets/TaskDetailDrawer'
import { fetchRunTimeline, fetchStepPrompt } from './api'
import type { StepPrompt } from './types'

interface StudioState {
  timeline: RunTimeline | undefined
  isLoading: boolean
  error: Error | null
}

/** Live run timeline for one task — Studio's node/edge data source. */
export const useStudio = (taskId: string, fetchImpl?: typeof fetch): StudioState => {
  const query = useQuery<RunTimeline>({
    queryKey: ['task', taskId, 'runs'],
    queryFn: () => fetchRunTimeline(taskId, fetchImpl ?? fetch),
    retry: false,
  })
  return {
    timeline: query.data,
    isLoading: query.isPending,
    error: query.error as Error | null,
  }
}

interface StepPromptState {
  data: StepPrompt | undefined
  isLoading: boolean
  error: Error | null
}

/**
 * The composed prompt for one step — fetched lazily (`enabled` flips true the
 * first time the node's Input / Show-trace panel opens), never as part of the
 * timeline list fetch.
 */
export const useStepPrompt = (
  taskId: string,
  runId: string,
  stepName: string,
  enabled: boolean,
  fetchImpl?: typeof fetch,
): StepPromptState => {
  const query = useQuery<StepPrompt>({
    queryKey: ['task', taskId, 'step-prompt', runId, stepName],
    queryFn: () => fetchStepPrompt(runId, stepName, fetchImpl ?? fetch),
    enabled,
    retry: false,
  })
  return {
    data: query.data,
    isLoading: enabled && query.isPending,
    error: query.error as Error | null,
  }
}
