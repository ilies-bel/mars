import { createScorer } from '@mastra/core/evals'
import { z } from 'zod'

const inputSchema = z.object({
  taskId: z.string(),
  integrationBranch: z.string(),
  path: z.string(),
  branch: z.string(),
  claudeExitCode: z.number(),
})

const outputSchema = z.object({
  taskId: z.string(),
  integrationBranch: z.string(),
  path: z.string(),
  branch: z.string(),
  verified: z.boolean(),
})

export const verifyPassedScorer = createScorer({
  id: 'verify-passed',
  description: '1 if typecheck/test/lint all passed in the verify step, 0 otherwise',
  type: { input: inputSchema, output: outputSchema },
})
  .generateScore(({ run }) => (run.output.verified ? 1 : 0))
  .generateReason(({ run, score }) =>
    score === 1
      ? `verify passed for task ${run.output.taskId} on ${run.output.branch}`
      : `verify failed for task ${run.output.taskId} on ${run.output.branch} (claude exit ${run.input?.claudeExitCode ?? 'unknown'})`,
  )
