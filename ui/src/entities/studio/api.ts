/**
 * Studio data access — thin fetchers over the run-timeline and step-prompt
 * endpoints.
 *
 * Studio consumes the SAME per-instance data the task drawer does:
 * `GET /api/runs/:taskId` (proxied to the daemon's `GET /view/runs/:taskId`)
 * is the single source for per-step status, duration, tokens, session ids,
 * failure reasons, and result JSON. No parallel run-detail shape exists —
 * the wire types are the drawer's exported RunTimeline family.
 *
 * The one Studio-specific read is `GET /api/step-prompt` — the composed
 * prompt sent to a step's worker, fetched lazily when a node's Input /
 * Show-trace panel opens (never inlined into timeline lists).
 */

import type { RunTimeline } from '@/widgets/TaskDetailDrawer'
import type { StepPrompt } from './types'

/** Fetches the full run timeline for a task. Throws on non-2xx. */
export const fetchRunTimeline = async (
  taskId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunTimeline> => {
  const res = await fetchImpl(`/api/runs/${encodeURIComponent(taskId)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as RunTimeline
}

/**
 * Fetches the composed prompt for one step of one workflow run.
 * Throws on non-2xx; a 200 with `prompt: null` means nothing is queryable
 * (the caller renders an explicit empty state, never invented data).
 */
export const fetchStepPrompt = async (
  workflowInstanceId: string,
  stepName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StepPrompt> => {
  const qs = `workflowInstanceId=${encodeURIComponent(workflowInstanceId)}&stepName=${encodeURIComponent(stepName)}`
  const res = await fetchImpl(`/api/step-prompt?${qs}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as StepPrompt
}
