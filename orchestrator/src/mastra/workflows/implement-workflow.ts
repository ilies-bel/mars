import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import {
  createWorktree,
  removeWorktree,
  runClaudeCode,
  verifyChanges,
  loadVerifySteps,
  mergeBranch,
  checkMergeTargetStatus,
} from '../lib/git'
import { resolveContext } from '../context'
import {
  installWorktreeDeps,
  WorktreeInstallError,
} from '../lib/worktree-install'
import type { ClaudeEvent } from '../lib/claude-stream'
import { getTask, hasIncompleteBlockers, updateTask, upsertTranscript } from '../queue'
import { handleTaskFailureWithFixTask } from '../queue-fix-tasks'
import { resolveOriginIdForTask } from '../lib/origin'

export const BLOCKERS_ABORT_MESSAGE = (taskId: string): string =>
  `task ${taskId} has incomplete blockers; aborting dispatch (task remains queued)`

export const isBlockersAbortError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('has incomplete blockers; aborting dispatch')
}
import { verifyPassedScorer } from '../scorers/verify-passed'
import { mergeCleanScorer } from '../scorers/merge-clean'
import { summarizeUsage } from '../lib/claude-usage'
import { recordSignals, isReflectDisabled } from '../lib/reflect-signals'

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

// Phases that the workflow can be resumed from. Mirrors {@link FailedPhase}
// in queue.ts but the workflow only ever resumes from a verify-or-later
// failure: 'code' failures (setup:install) are non-resumable.
const resumeFromSchema = z.enum(['verify', 'merge']).nullable().default(null)

const STEP_ORDER = ['setup-worktree', 'run-claude-code', 'verify', 'merge'] as const

// Map a resume hint to the rank of the first step that should actually
// execute. Steps with a lower rank pass through, reusing the persisted
// branch + worktree from the previous run.
const resumeRank = (resumeFrom: 'verify' | 'merge' | null): number => {
  if (resumeFrom === 'verify') return STEP_ORDER.indexOf('verify')
  if (resumeFrom === 'merge') return STEP_ORDER.indexOf('merge')
  return 0
}

// Mandatory footer appended to every implementor prompt. The verify step
// fails any task whose branch has zero commits ahead of integration, so
// exiting without staging and committing produces a `verify:has-diff/
// no-commits-ahead` failure that routes to the recovery recipe. Forcing
// the instruction at the primitive guarantees every implementor —
// user-authored, plan-driven, sliced, or otherwise — sees the same
// commit contract, regardless of what the upstream prompt happened to
// include.
export const COMMIT_FOOTER = [
  '## Save your work',
  '',
  'Before exiting, stage and commit every file you intend to land:',
  '',
  '```',
  'git add -A',
  'git commit -m "<message describing the change>"',
  '```',
  '',
  'The orchestrator does not commit on your behalf. The verify step rejects any task branch with zero commits ahead of integration — exiting without a commit triggers the `verify:has-diff/no-commits-ahead` failure and parks this task in `blocked`.',
].join('\n')

export const composePrompt = (
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
  sections.push(COMMIT_FOOTER)
  return sections.join('\n\n')
}

const setupStep = createStep({
  id: 'setup-worktree',
  inputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    plan: planSchema.default(null),
    integrationBranch: z.string().default('main'),
    resumeFrom: resumeFromSchema,
  }),
  outputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    plan: planSchema,
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    resumeFrom: resumeFromSchema,
  }),
  execute: async ({ inputData, tracingContext }) => {
    const originId = await resolveOriginIdForTask(inputData.taskId)
    tracingContext?.currentSpan?.update({
      metadata: { originId, taskId: inputData.taskId },
    })
    if (await hasIncompleteBlockers(inputData.taskId)) {
      throw new Error(BLOCKERS_ABORT_MESSAGE(inputData.taskId))
    }

    // Resume short-circuit: 'mars continue' restarted this task on the
    // existing branch+worktree. Skip worktree creation and dep install;
    // re-use whatever the previous run committed.
    if (resumeRank(inputData.resumeFrom) > STEP_ORDER.indexOf('setup-worktree')) {
      const persisted = await getTask(inputData.taskId)
      if (!persisted?.branch || !persisted?.worktreePath) {
        throw new Error(
          `task ${inputData.taskId} has resumeFrom=${inputData.resumeFrom} but no branch/worktree on the row; refusing to resume`,
        )
      }
      return {
        ...inputData,
        path: persisted.worktreePath,
        branch: persisted.branch,
      }
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
        failedPhase: 'code',
      })
      await handleTaskFailureWithFixTask({
        taskId: inputData.taskId,
        failingStep: 'setup:install',
        // Lead with a classifier-friendly summary; the recipe gets the
        // raw error via recipeContext.statusOutput.
        errorOutput: `frozen-lockfile install failed\n${errorOutput}`,
        branch: ref.branch,
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
    resumeFrom: resumeFromSchema,
  }),
  outputSchema: z.object({
    taskId: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    claudeExitCode: z.number(),
    resumeFrom: resumeFromSchema,
  }),
  execute: async ({ inputData, writer, tracingContext }) => {
    // Resume short-circuit: the worker already ran in a previous attempt
    // and committed its work. Skip the claude-code invocation entirely;
    // pass-through with a synthetic exit code 0.
    if (resumeRank(inputData.resumeFrom) > STEP_ORDER.indexOf('run-claude-code')) {
      return {
        taskId: inputData.taskId,
        integrationBranch: inputData.integrationBranch,
        path: inputData.path,
        branch: inputData.branch,
        claudeExitCode: 0,
        resumeFrom: inputData.resumeFrom,
      }
    }

    const originId = await resolveOriginIdForTask(inputData.taskId)
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
        originId,
        taskId: inputData.taskId,
        claudeSessionId: r.sessionId,
        usage,
      },
    })
    if (r.sessionId) {
      await updateTask(inputData.taskId, { claudeSessionId: r.sessionId })
    }
    await recordSignals(inputData.taskId, 'run-claude-code', usage).catch(() => {
      // signal capture must never fail the task
    })
    if (!isReflectDisabled()) {
      await upsertTranscript({
        taskId: inputData.taskId,
        conversationJson: JSON.stringify(conversation),
      }).catch(() => {
        // transcript capture must never fail the task
      })
    }
    return {
      taskId: inputData.taskId,
      integrationBranch: inputData.integrationBranch,
      path: inputData.path,
      branch: inputData.branch,
      claudeExitCode: r.exitCode,
      resumeFrom: inputData.resumeFrom,
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
    resumeFrom: resumeFromSchema,
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
  execute: async ({ inputData, tracingContext }) => {
    const originId = await resolveOriginIdForTask(inputData.taskId)
    tracingContext?.currentSpan?.update({
      metadata: { originId, taskId: inputData.taskId },
    })

    // Resume short-circuit: 'mars continue' is jumping straight to merge.
    // Verify already passed in the previous run; trust it and pass through.
    if (resumeRank(inputData.resumeFrom) > STEP_ORDER.indexOf('verify')) {
      return {
        taskId: inputData.taskId,
        integrationBranch: inputData.integrationBranch,
        path: inputData.path,
        branch: inputData.branch,
        verified: true,
      }
    }

    // Entering verify for real: clear both the previous failure stamp and
    // the resume hint so a subsequent failure records this run's phase.
    await updateTask(inputData.taskId, {
      status: 'verifying',
      failedPhase: null,
      resumeFrom: null,
    })
    const verifyCwd = resolveVerifyCwd(inputData.path)
    const ctx = resolveContext()
    const steps = await loadVerifySteps(ctx.supervisorsManifest)
    const r = await verifyChanges({
      cwd: verifyCwd,
      steps,
      branch: inputData.branch,
      integrationBranch: inputData.integrationBranch,
    })

    if (!isReflectDisabled()) {
      const verifyOutput = r.steps
        .map((s) => `=== ${s.name} (${s.passed ? 'pass' : 'fail'}) ===\n${s.output}`)
        .join('\n\n')
      await upsertTranscript({
        taskId: inputData.taskId,
        verifyOutput,
      }).catch(() => {
        // transcript capture must never fail the task
      })
    }

    if (!r.passed) {
      const failed = r.steps.filter((s) => !s.passed)
      const summary = failed
        .map((s) => `${s.name}: ${s.output.slice(0, 500)}`)
        .join('\n')
      const firstFailedName = failed[0]?.name ?? 'verify'
      const firstFailedOutput = failed[0]?.output ?? summary
      await updateTask(inputData.taskId, {
        status: 'failed',
        error: summary,
        failedPhase: 'verify',
      })
      await handleTaskFailureWithFixTask({
        taskId: inputData.taskId,
        failingStep: `verify:${firstFailedName}`,
        errorOutput: firstFailedOutput,
        branch: inputData.branch,
        recipeContext: {
          targetPath: inputData.path,
          statusOutput: firstFailedOutput,
          targetBranch: inputData.branch,
          integrationBranch: inputData.integrationBranch,
        },
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
    const originId = await resolveOriginIdForTask(inputData.taskId)
    tracingContext?.currentSpan?.update({
      metadata: { originId, taskId: inputData.taskId },
    })
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
      // Entering merge for real: clear any previous failure stamp + the
      // resume hint so a subsequent failure records this run's phase.
      await updateTask(inputData.taskId, {
        status: 'merging',
        failedPhase: null,
        resumeFrom: null,
      })

      const targetStatus = await checkMergeTargetStatus()
      if (targetStatus.kind === 'dirty') {
        const errorMsg = `merge target has uncommitted changes; cannot fast-forward into ${inputData.integrationBranch}`
        await updateTask(inputData.taskId, {
          status: 'failed',
          error: errorMsg,
          failedPhase: 'merge',
        })
        await handleTaskFailureWithFixTask({
          taskId: inputData.taskId,
          failingStep: 'merge:preflight',
          // Classifier-friendly lead line; raw porcelain via recipeContext.
          errorOutput: `merge target ${targetStatus.targetPath} has uncommitted changes blocking fast-forward\n${targetStatus.statusOutput}`,
          branch: inputData.branch,
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
          failedPhase: 'merge',
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
            originId,
            taskId: inputData.taskId,
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
          failedPhase: 'merge',
        })
        await handleTaskFailureWithFixTask({
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
      await updateTask(inputData.taskId, { status: 'done', failedPhase: null })

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
        failedPhase: 'merge',
      })
      await handleTaskFailureWithFixTask({
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
    resumeFrom: resumeFromSchema,
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
