/**
 * Studio entity types.
 *
 * The run-timeline shapes (RunTimeline / RunTimelineEntry / RunTimelineStep /
 * StepCardEntry) are NOT redefined here — Studio reuses the drawer's exported
 * wire types (`@/widgets/TaskDetailDrawer`) so both surfaces stay pinned to
 * the single `GET /api/runs/:taskId` contract.
 */

/**
 * Wire shape of `GET /api/step-prompt` — the composed prompt sent to one
 * step's worker.
 *
 * `source` is provenance: 'persisted' when written at emit time on the
 * step_started event; 'recovered' when best-effort extracted from a stored
 * or on-disk transcript (the UI must label it 'recovered from transcript');
 * null (with `prompt` null) when nothing is queryable — rendered as an
 * explicit empty state, never invented data.
 */
export interface StepPrompt {
  workflowInstanceId: string
  stepName: string
  prompt: string | null
  source: 'persisted' | 'recovered' | null
}
