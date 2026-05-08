import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { mergeBranch } from '../lib/git'

export const mergeTool = createTool({
  id: 'merge-branch',
  description:
    'Merge a task branch into the integration branch. Last-writer-wins on conflict.',
  inputSchema: z.object({
    branch: z.string(),
    worktreePath: z.string(),
    integrationBranch: z.string().optional(),
    lockTimeoutMs: z.number().optional(),
  }),
  outputSchema: z.object({
    merged: z.boolean(),
    conflictResolved: z.boolean(),
    aborted: z.boolean(),
    output: z.string(),
  }),
  execute: async (inputData) =>
    mergeBranch({
      branch: inputData.branch,
      worktreePath: inputData.worktreePath,
      integrationBranch: inputData.integrationBranch ?? 'integration',
      lockTimeoutMs: inputData.lockTimeoutMs ?? 5 * 60 * 1000,
    }),
})
