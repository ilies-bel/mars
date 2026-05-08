import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { verifyChanges, type VerifyStepSpec } from '../lib/git'

const stepSchema = z.object({
  name: z.string(),
  cmd: z.string(),
  args: z.array(z.string()),
  required: z.boolean().default(true),
})

const DEFAULT_STEPS: VerifyStepSpec[] = [
  { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
  { name: 'test', cmd: 'npm', args: ['test', '--silent'], required: true },
  { name: 'lint', cmd: 'npx', args: ['biome', 'check', '.'], required: true },
]

export const verifyTool = createTool({
  id: 'verify-changes',
  description: 'Run typecheck, tests, and lint in a worktree.',
  inputSchema: z.object({
    cwd: z.string(),
    steps: z.array(stepSchema).optional(),
  }),
  outputSchema: z.object({
    passed: z.boolean(),
    steps: z.array(
      z.object({
        name: z.string(),
        passed: z.boolean(),
        output: z.string(),
      }),
    ),
  }),
  execute: async (inputData) => {
    const steps: VerifyStepSpec[] = inputData.steps
      ? inputData.steps.map((s) => ({
          name: s.name,
          cmd: s.cmd,
          args: s.args,
          required: s.required ?? true,
        }))
      : DEFAULT_STEPS
    return verifyChanges({ cwd: inputData.cwd, steps })
  },
})
