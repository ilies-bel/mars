import { createScorer } from '@mastra/core/evals'
import { z } from 'zod'

const inputSchema = z.object({
  taskId: z.string(),
  integrationBranch: z.string(),
  path: z.string(),
  branch: z.string(),
  verified: z.boolean(),
})

const outputSchema = z.object({
  taskId: z.string(),
  success: z.boolean(),
  message: z.string(),
})

type MergeOutcome = 'clean' | 'vega-resolved' | 'aborted' | 'skipped'

const classify = (
  input: z.infer<typeof inputSchema> | undefined,
  output: z.infer<typeof outputSchema>,
): MergeOutcome => {
  if (input && !input.verified) return 'skipped'
  if (!output.success) return 'aborted'
  return output.message.includes('vcs-supervisor') ? 'vega-resolved' : 'clean'
}

const SCORE: Record<MergeOutcome, number> = {
  clean: 1,
  'vega-resolved': 0.7,
  aborted: 0,
  skipped: 0,
}

export const mergeCleanScorer = createScorer({
  id: 'merge-clean',
  description:
    'Merge outcome: 1 clean, 0.7 vega-resolved (conflict reconciled), 0 aborted/skipped',
  type: { input: inputSchema, output: outputSchema },
})
  .analyze(({ run }) => {
    const outcome = classify(run.input, run.output)
    return { outcome }
  })
  .generateScore(({ results }) => SCORE[results.analyzeStepResult.outcome])
  .generateReason(({ results, run, score }) => {
    const { outcome } = results.analyzeStepResult
    return `task ${run.output.taskId}: merge ${outcome} (score ${score}) — ${run.output.message}`
  })
