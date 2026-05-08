import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { createWorktree, removeWorktree } from '../lib/git'

export const createWorktreeTool = createTool({
  id: 'create-worktree',
  description: 'Create a new git worktree on a fresh branch off the integration branch (default: main).',
  inputSchema: z.object({
    taskId: z.string(),
    integrationBranch: z.string().optional(),
  }),
  outputSchema: z.object({
    path: z.string(),
    branch: z.string(),
  }),
  execute: async (inputData) =>
    createWorktree({
      taskId: inputData.taskId,
      integrationBranch: inputData.integrationBranch ?? 'main',
    }),
})

export const removeWorktreeTool = createTool({
  id: 'remove-worktree',
  description: 'Remove a git worktree and delete its branch.',
  inputSchema: z.object({
    path: z.string(),
    branch: z.string(),
    force: z.boolean().default(true),
  }),
  outputSchema: z.object({ removed: z.boolean() }),
  execute: async (inputData) => {
    await removeWorktree({ path: inputData.path, branch: inputData.branch }, inputData.force)
    return { removed: true }
  },
})
