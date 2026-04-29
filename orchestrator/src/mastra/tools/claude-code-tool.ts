import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { runClaudeCode } from '../lib/git'

export const claudeCodeTool = createTool({
  id: 'run-claude-code',
  description: 'Run Claude Code headless in a worktree to perform a coding task.',
  inputSchema: z.object({
    cwd: z.string(),
    prompt: z.string(),
    timeoutMs: z.number().optional(),
  }),
  outputSchema: z.object({
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  execute: async (inputData) =>
    runClaudeCode({
      cwd: inputData.cwd,
      prompt: inputData.prompt,
      timeoutMs: inputData.timeoutMs ?? 20 * 60 * 1000,
    }),
})
