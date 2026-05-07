import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import {
  createWorktree,
  removeWorktree,
  runClaudeCode,
  verifyChanges,
  mergeBranch,
} from '../lib/git'
import { updateTask } from '../queue'

const resolveVerifyCwd = (worktreeRoot: string): string => {
  if (existsSync(resolve(worktreeRoot, 'package.json'))) return worktreeRoot
  const orchestrator = resolve(worktreeRoot, 'orchestrator')
  if (existsSync(resolve(orchestrator, 'package.json'))) return orchestrator
  return worktreeRoot
}

const setupStep = createStep({
  id: 'setup-worktree',
  inputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    integrationBranch: z.string().default('integration'),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
  }),
  execute: async ({ inputData }) => {
    await updateTask(inputData.taskId, { status: 'running' })
    const ref = await createWorktree({
      taskId: inputData.taskId,
      integrationBranch: inputData.integrationBranch,
    })
    await updateTask(inputData.taskId, {
      branch: ref.branch,
      worktreePath: ref.path,
    })
    return { ...inputData, ...ref }
  },
})

const codeStep = createStep({
  id: 'run-claude-code',
  inputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    claudeExitCode: z.number(),
  }),
  execute: async ({ inputData }) => {
    const r = await runClaudeCode({
      cwd: inputData.path,
      prompt: inputData.prompt,
      timeoutMs: 20 * 60 * 1000,
    })
    if (r.sessionId) {
      await updateTask(inputData.taskId, { claudeSessionId: r.sessionId })
    }
    return { ...inputData, claudeExitCode: r.exitCode }
  },
})

const verifyStep = createStep({
  id: 'verify',
  inputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    claudeExitCode: z.number(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    verified: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    await updateTask(inputData.taskId, { status: 'verifying' })
    const verifyCwd = resolveVerifyCwd(inputData.path)
    const r = await verifyChanges({
      cwd: verifyCwd,
      typecheckCmd: ['npx', ['tsc', '--noEmit']],
      testCmd: ['npm', ['test', '--silent']],
      lintCmd: ['npx', ['biome', 'check', '.']],
    })

    if (!r.passed) {
      const summary = r.steps
        .filter((s) => !s.passed)
        .map((s) => `${s.name}: ${s.output.slice(0, 500)}`)
        .join('\n')
      await updateTask(inputData.taskId, { status: 'failed', error: summary })
    }

    return {
      taskId: inputData.taskId,
      integrationBranch: inputData.integrationBranch,
      path: inputData.path,
      branch: inputData.branch,
      verified: r.passed,
    }
  },
})

const mergeStep = createStep({
  id: 'merge',
  inputSchema: z.object({
    taskId: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    verified: z.boolean(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ inputData }) => {
    if (!inputData.verified) {
      return {
        taskId: inputData.taskId,
        success: false,
        message: 'verification failed; worktree retained for inspection',
      }
    }

    await updateTask(inputData.taskId, { status: 'merging' })
    const m = await mergeBranch({
      branch: inputData.branch,
      integrationBranch: inputData.integrationBranch,
      lockTimeoutMs: 5 * 60 * 1000,
    })

    if (m.aborted) {
      await updateTask(inputData.taskId, {
        status: 'failed',
        error: `merge aborted by vcs-supervisor; worktree retained at ${inputData.path}\n${m.output.slice(0, 1000)}`,
      })
      return {
        taskId: inputData.taskId,
        success: false,
        message: 'merge aborted; vcs-supervisor could not reconcile, worktree retained',
      }
    }

    await removeWorktree({ path: inputData.path, branch: inputData.branch }, true)
    await updateTask(inputData.taskId, { status: 'done' })

    return {
      taskId: inputData.taskId,
      success: true,
      message: m.conflictResolved
        ? 'merged with vcs-supervisor conflict resolution'
        : 'merged cleanly',
    }
  },
})

export const implementWorkflow = createWorkflow({
  id: 'implement',
  inputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    integrationBranch: z.string().default('integration'),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    success: z.boolean(),
    message: z.string(),
  }),
})
  .then(setupStep)
  .then(codeStep)
  .then(verifyStep)
  .then(mergeStep)
  .commit()
