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
  checkMergeTargetStatus,
} from '../lib/git'
import {
  installWorktreeDeps,
  WorktreeInstallError,
} from '../lib/worktree-install'
import type { ClaudeEvent } from '../lib/claude-stream'
import { hasIncompleteBlockers, updateTask } from '../queue'
import { handleTaskFailure } from '../queue-fix-suggestions'

export const BLOCKERS_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} has incomplete blockers; aborting dispatch (task remains queued)`

export const isBlockersAbortError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('has incomplete blockers; aborting dispatch')
}
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
    integrationBranch: z.string().default('main'),
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
    if (await hasIncompleteBlockers(inputData.taskId)) {
      throw new Error(BLOCKERS_ABORT_MESSAGE(inputData.taskId))
    }
    await updateTask(inputData.taskId, { status: 'running' })
    const ref = await createWorktree({
      taskId: inputData.taskId,
      integrationBranch: inputData.integrationBranch,
    })
    await updateTask(inputData.taskId, {
      branch: ref.branch,
      worktreePath: ref.path,
    })

    try {
      const summary = await installWorktreeDeps({
        worktreeRoot: ref.path,
        log: (line) => console.log(line),
      })
      if (summary.sites.length > 0) {
        console.log(
          `[setup] task ${inputData.taskId} install completed in ${(
            summary.totalDurationMs / 1000
          ).toFixed(1)}s (${summary.sites.length} manifest${summary.sites.length === 1 ? '' : 's'})`,
        )
      }
    } catch (error: unknown) {
      const isInstallErr = error instanceof WorktreeInstallError
      const errorOutput = isInstallErr ? error.message : String(error)
      const summary = errorOutput.slice(0, 1000)
      await updateTask(inputData.taskId, {
        status: 'failed',
        error: summary,
      })
      await handleTaskFailure({
        taskId: inputData.taskId,
        failingStep: 'setup:install',
        errorOutput,
        branch: ref.branch,
        recipeSignature: 'worktree_install_failed',
        recipeContext: {
          targetPath: isInstallErr ? error.site.dir : ref.path,
          statusOutput: errorOutput,
          targetBranch: ref.branch,
        },
      }).catch((err) => {
        console.error(
          `[failure-handler] task ${inputData.taskId} setup:install handling errored:`,
          err,
        )
      })
      throw error instanceof Error ? error : new Error(errorOutput)
    }

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
      const failed = r.steps.filter((s) => !s.passed)
      const summary = failed
        .map((s) => `${s.name}: ${s.output.slice(0, 500)}`)
        .join('\n')
      const firstFailedName = failed[0]?.name ?? 'verify'
      const firstFailedOutput = failed[0]?.output ?? summary
      await updateTask(inputData.taskId, { status: 'failed', error: summary })
      await handleTaskFailure({
        taskId: inputData.taskId,
        failingStep: `verify:${firstFailedName}`,
        errorOutput: firstFailedOutput,
        branch: inputData.branch,
      }).catch((err) => {
        console.error(
          `[failure-handler] task ${inputData.taskId} verify failure handling errored:`,
          err,
        )
      })
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

    // Any unhandled throw from mergeBranch (e.g. an unexpected git failure)
    // must transition the task to a terminal status. Otherwise the queue row
    // stays at 'merging' forever and `mars list` hides the failure.
    try {
      await updateTask(inputData.taskId, { status: 'merging' })

      const targetStatus = await checkMergeTargetStatus()
      if (targetStatus.kind === 'dirty') {
        const errorMsg = `merge target has uncommitted changes; cannot fast-forward into ${inputData.integrationBranch}`
        await updateTask(inputData.taskId, {
          status: 'failed',
          error: errorMsg,
        })
        await handleTaskFailure({
          taskId: inputData.taskId,
          failingStep: 'merge:preflight',
          errorOutput: targetStatus.statusOutput,
          branch: inputData.branch,
          recipeSignature: 'dirty_merge_target',
          recipeContext: {
            targetPath: targetStatus.targetPath,
            statusOutput: targetStatus.statusOutput,
            targetBranch: inputData.integrationBranch,
          },
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${inputData.taskId} dirty-merge-target handling errored:`,
            err,
          )
        })
        return {
          taskId: inputData.taskId,
          success: false,
          message: `merge pre-flight detected dirty target ${inputData.integrationBranch}; worktree retained`,
        }
      }
      if (targetStatus.kind === 'error') {
        await updateTask(inputData.taskId, {
          status: 'failed',
          error: `merge pre-flight git status failed: ${targetStatus.error.message}`.slice(0, 1000),
        })
        return {
          taskId: inputData.taskId,
          success: false,
          message: `merge pre-flight failed: ${targetStatus.error.message}`,
        }
      }
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
        const errorMsg = `merge aborted by vcs-supervisor; worktree retained at ${inputData.path}\n${m.output.slice(0, 1000)}`
        await updateTask(inputData.taskId, {
          status: 'failed',
          error: errorMsg,
        })
        await handleTaskFailure({
          taskId: inputData.taskId,
          failingStep: 'merge:vcs-supervisor-aborted',
          errorOutput: m.output,
          branch: inputData.branch,
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${inputData.taskId} merge abort handling errored:`,
            err,
          )
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[merge] task ${inputData.taskId} crashed:`, error)
      await updateTask(inputData.taskId, {
        status: 'failed',
        error: `merge step crashed: ${message}`.slice(0, 1000),
      })
      await handleTaskFailure({
        taskId: inputData.taskId,
        failingStep: 'merge:crashed',
        errorOutput: message,
        branch: inputData.branch,
      }).catch((err) => {
        console.error(
          `[failure-handler] task ${inputData.taskId} merge crash handling errored:`,
          err,
        )
      })
      return {
        taskId: inputData.taskId,
        success: false,
        message: 'merge step crashed; worktree retained',
      }
    }
  },
})

export const implementWorkflow = createWorkflow({
  id: 'implement',
  inputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    plan: planSchema.default(null),
    integrationBranch: z.string().default('main'),
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
