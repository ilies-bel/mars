import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { verifyChanges } from '../lib/git'

const cmdTuple = z.tuple([z.string(), z.array(z.string())])

export const verifyTool = createTool({
  id: 'verify-changes',
  description: 'Run typecheck, tests, and lint in a worktree.',
  inputSchema: z.object({
    cwd: z.string(),
    typecheckCmd: cmdTuple.optional(),
    testCmd: cmdTuple.optional(),
    lintCmd: cmdTuple.optional(),
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
  execute: async (inputData) =>
    verifyChanges({
      cwd: inputData.cwd,
      typecheckCmd: inputData.typecheckCmd ?? ['npx', ['tsc', '--noEmit']],
      testCmd: inputData.testCmd ?? ['npm', ['test', '--silent']],
      lintCmd: inputData.lintCmd ?? ['npx', ['biome', 'check', '.']],
    }),
})
