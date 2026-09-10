/**
 * useTaskScore — the scorer verdict for one task, as the Scores table sees it.
 *
 * The detail page at `#/studio/<taskId>` is reached by clicking a score, so it
 * has to be able to show that score. The run timeline the page already fetches
 * cannot supply one: the scorer's own step span records a duration and token
 * counts, and its `resultJson` is null on every scored run in this repo, so
 * the verdict exists only in the loop ledger.
 *
 * Workflow selection deliberately mirrors the index page — the first scorer
 * workflow — so both sides of the navigation read the same row. If a second
 * scorer workflow ever appears, the workflow belongs in the route rather than
 * being guessed here; there is exactly one today (`task`).
 */

import { useLoopLedger, type LoopLedgerEntry } from './useLoopLedger'
import { useScorerWorkflows } from './useScorerWorkflows'

export interface TaskScoreState {
  /** The ledger row for this task, or null once we know there isn't one. */
  entry: LoopLedgerEntry | null
  isLoading: boolean
}

export const useTaskScore = (taskId: string): TaskScoreState => {
  const { data: workflows, isLoading: workflowsLoading } = useScorerWorkflows()
  const workflow = workflows?.[0] ?? null
  const { entries, isLoading } = useLoopLedger(workflow)

  return {
    entry: entries.find((e) => e.runId === taskId) ?? null,
    isLoading: workflowsLoading || isLoading,
  }
}
