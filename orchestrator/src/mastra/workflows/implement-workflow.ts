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
import type { ClaudeEvent } from '../lib/claude-stream'
import { updateTask } from '../queue'
import { verifyPassedScorer } from '../scorers/verify-passed'
import { mergeCleanScorer } from '../scorers/merge-clean'
import { summarizeUsage } from '../lib/claude-usage'
import { recordSignals } from '../lib/reflect-signals'

const resolveVerifyCwd = (worktreeRoot: string): string => {
  const hasProject = (dir: string): boolean =>
    existsSync(resolve(dir, 'package.json')) &&
    existsSync(resolve(dir, 'tsconfig.json'))
  if (hasProject(worktreeRoot)) return worktreeRoot
  const orchestrator = resolve(worktreeRoot, 'orchestrator')
  if (hasProject(orchestrator)) return orchestrator
  return worktreeRoot
}

const planSchema = z
  .object({
    functional: z.string(),
    technical: z.string(),
  })
  .nullable()

const composePrompt = (
  prompt: string,
  plan: z.infer<typeof planSchema>,
): string => {
  const sections: string[] = [prompt.trim()]
  if (plan?.functional?.trim()) {
    sections.push(`## Functional plan\n\n${plan.functional.trim()}`)
  }
  if (plan?.technical?.trim()) {
    sections.push(`## Technical plan\n\n${plan.technical.trim()}`)
  }
  return sections.join('\n\n')
}

const setupStep = createStep({
  id: 'setup-worktree',
  inputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    plan: planSchema.default(null),
    integrationBranch: z.string().default('integration'),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    plan: planSchema,
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
    plan: planSchema,
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    claudeExitCode: z.number(),
  }),
  execute: async ({ inputData, writer, tracingContext }) => {
    const fullPrompt = composePrompt(inputData.prompt, inputData.plan)
    const conversation: ClaudeEvent[] = []
    const r = await runClaudeCode({
      cwd: inputData.path,
      prompt: fullPrompt,
      timeoutMs: 20 * 60 * 1000,
      onEvent: async (event) => {
        conversation.push(event)
        await writer?.write({ type: 'claude-event', event })
      },
    })
    const usage = summarizeUsage(conversation)
    tracingContext?.currentSpan?.update({
      metadata: {
        claudeSessionId: r.sessionId,
        conversation,
        conversationBytes: JSON.stringify(conversation).length,
        usage,
      },
    })
    if (r.sessionId) {
      await updateTask(inputData.taskId, { claudeSessionId: r.sessionId })
    }
    await recordSignals(inputData.taskId, 'run-claude-code', usage).catch(() => {
      // signal capture must never fail the task
    })
    return {
      taskId: inputData.taskId,
      integrationBranch: inputData.integrationBranch,
      path: inputData.path,
      branch: inputData.branch,
      claudeExitCode: r.exitCode,
    }
  },
})

const verifyStep = createStep({
  id: 'verify',
  inputSchema: z.object({
    taskId: z.string(),
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
  scorers: {
    verifyPassed: {
      scorer: verifyPassedScorer,
      sampling: { type: 'ratio', rate: 1 },
    },
  },
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
  scorers: {
    mergeClean: {
      scorer: mergeCleanScorer,
      sampling: { type: 'ratio', rate: 1 },
    },
  },
  execute: async ({ inputData, writer, tracingContext }) => {
    if (!inputData.verified) {
      return {
        taskId: inputData.taskId,
        success: false,
        message: 'verification failed; worktree retained for inspection',
      }
    }

    await updateTask(inputData.taskId, { status: 'merging' })
    const supervisorConversation: ClaudeEvent[] = []
    const m = await mergeBranch({
      branch: inputData.branch,
      worktreePath: inputData.path,
      integrationBranch: inputData.integrationBranch,
      lockTimeoutMs: 5 * 60 * 1000,
      onSupervisorEvent: async (event) => {
        supervisorConversation.push(event)
        await writer?.write({ type: 'vcs-supervisor-event', event })
      },
    })

    if (supervisorConversation.length > 0) {
      const supervisorUsage = summarizeUsage(supervisorConversation)
      tracingContext?.currentSpan?.update({
        metadata: {
          supervisorConversation,
          supervisorConversationBytes: JSON.stringify(supervisorConversation).length,
          supervisorUsage,
        },
      })
      await recordSignals(inputData.taskId, 'vcs-supervisor', supervisorUsage).catch(() => {
        // signal capture must never fail the task
      })
    }

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
    plan: planSchema.default(null),
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
