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
 * `source` is provenance:
 *   - 'persisted'    — written at emit time on the step_started event.
 *   - 'recovered'    — best-effort extracted from a stored/on-disk transcript
 *                      (label as 'recovered from transcript' in the UI).
 *   - 'none'         — non-LLM step (setup/verify/merge); no prompt exists for
 *                      this step kind by design.
 *   - 'not-captured' — LLM-backed step but no prompt data survived; the run
 *                      predates persistence. Render as an explicit visible gap.
 *   - null           — the step was not found in the trace store at all.
 *
 * Never conflate 'none', 'not-captured', and null — each requires its own label.
 */
export interface StepPrompt {
  workflowInstanceId: string
  stepName: string
  prompt: string | null
  source: 'persisted' | 'recovered' | 'none' | 'not-captured' | null
}
