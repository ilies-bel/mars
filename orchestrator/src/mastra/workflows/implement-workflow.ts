import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import {
  cleanWorktreeIfNoCommitsAhead,
  createWorktree,
  removeWorktree,
  verifyChanges,
  loadVerifySteps,
  mergeBranch,
  checkMergeTargetStatus,
} from '../lib/git'
import { getWorkerForTag } from '../workers'
import { TASK_TAGS, isTaskTag, type TaskTag } from '../queue'
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
import { resolveVerifyCwd } from '../lib/derive-repro-command'

const planSchema = z
  .object({
    functional: z.string(),
    technical: z.string(),
  })
  .nullable()

// Worker-routing tag, mirroring {@link TaskTag}. Defaults to 'coder' when
// the dispatcher omits it (legacy/tagless rows) so the workflow keeps
// running on Coder unless a tag is explicitly threaded through.
const tagSchema: z.ZodType<TaskTag> = z.enum(TASK_TAGS as readonly [TaskTag, ...TaskTag[]])
  .default('coder')

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
  '`git add` alone is not enough — staged-but-uncommitted changes are invisible to verify and the merge step. You must run `git commit`.',
  '',
  'Then, as the final action before exiting, self-check that the commit landed on your branch. Run:',
  '',
  '```',
  'git rev-list --count HEAD ^$(git merge-base HEAD @{upstream} 2>/dev/null || git rev-parse origin/main 2>/dev/null || echo HEAD)',
  '```',
  '',
  'or, more simply, count commits since branching off integration:',
  '',
  '```',
  'git rev-list --count $(git rev-parse --abbrev-ref HEAD)@{u}..HEAD 2>/dev/null || git rev-list --count main..HEAD',
  '```',
  '',
  'The number MUST be greater than `0`. If it prints `0`, your work is staged but not committed — re-run `git commit` and re-check. Do not exit while this number is `0`; verify will reject the run with `verify:has-diff/no-commits-ahead` and park this task in `blocked`.',
  '',
  'The orchestrator does not commit on your behalf.',
].join('\n')

// Footer for Writer tasks. The Writer lands its work via `mars glossary
// set/remove` and `mars adr add`, both of which route through the daemon's
// structured-write path and commit on the integration branch directly —
// there is no worktree commit to make. Telling the Writer to run
// `git add -A && git commit` (the Coder footer) would be a no-op at best
// and confuse the agent into thinking it failed at worst. Instead, the
// Writer footer names the canonical verbs and reminds it that the
// daemon, not the worktree, owns the commit.
export const WRITER_FOOTER = [
  '## Save your work',
  '',
  'You are a Writer worker. You cannot edit files in this worktree directly. Land every change through the canonical daemon verbs:',
  '',
  '- `mars glossary set "<term>" "<definition>"` to add or update a glossary term.',
  '- `mars glossary remove "<term>"` to retire a glossary term.',
  '- `mars adr add --title "<title>" --body "<body>"` to record an ADR.',
  '',
  'Each call routes through the structured-write daemon, which performs the file edit on its own internal worktree and merges into the integration branch. You do not run `git add` or `git commit` yourself — the daemon owns the commit.',
  '',
  'After every call succeeds, verify the change took effect (e.g. `mars glossary show "<term>"` or `mars adr show <NNNN>`) before moving to the next acceptance criterion. When every criterion is satisfied, exit.',
].join('\n')

// System prompt injected on top of the worker's default for Writer Sessions.
// Pins the agent's mental model to the structured-write verbs so it does not
// reach for Edit/Write (which are denied at the wrapper layer anyway) when
// asked to update CONTEXT.md or docs/adr/**.
export const WRITER_SYSTEM_PROMPT = [
  'You are the Writer worker.',
  '',
  'You land documentation changes (glossary terms, ADRs) by calling the Mars CLI verbs that route through the structured-write daemon, NOT by editing files in this worktree.',
  '',
  'The only mutation verbs available to you are:',
  '  - mars glossary set "<term>" "<definition>" [--aliases "<alias1>,<alias2>"]',
  '  - mars glossary remove "<term>"',
  '  - mars adr add --title "<title>" --body "<body>"',
  '',
  'You may read freely (Read, Grep, Glob, Bash for read-only commands). Edit, Write, and NotebookEdit are disabled — attempting to edit CONTEXT.md or docs/adr/** in the worktree will fail.',
  '',
  'When every acceptance criterion is satisfied via the verbs above, exit cleanly. The daemon commits each verb on the integration branch on your behalf.',
].join('\n')

export const composePrompt = (
  prompt: string,
  plan: z.infer<typeof planSchema>,
  tag: TaskTag = 'coder',
): string => {
  const sections: string[] = [prompt.trim()]
  if (plan?.functional?.trim()) {
    sections.push(`## Functional plan\n\n${plan.functional.trim()}`)
  }
  if (plan?.technical?.trim()) {
    sections.push(`## Technical plan\n\n${plan.technical.trim()}`)
  }
  sections.push(tag === 'writer' ? WRITER_FOOTER : COMMIT_FOOTER)
  return sections.join('\n\n')
}

const setupStep = createStep({
  id: 'setup-worktree',
  inputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    plan: planSchema.default(null),
    tag: tagSchema,
    integrationBranch: z.string().default('main'),
    resumeFrom: resumeFromSchema,
  }),
  outputSchema: z.object({
    taskId: z.string(),
    prompt: z.string(),
    plan: planSchema,
    tag: tagSchema,
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
          // Handler backfills from task.prompt when '' is passed.
          originalPrompt: '',
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
    tag: tagSchema,
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
    tag: tagSchema,
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
        tag: inputData.tag,
        claudeExitCode: 0,
        resumeFrom: inputData.resumeFrom,
      }
    }

    // Sweep stray untracked files from a previous failed attempt on this
    // branch BEFORE invoking the agent. Without this, a re-dispatch of a
    // source task that the orchestrator unblocked after a recovery
    // inherits the prior Coder's debris (e.g. files written under a
    // wrongly-nested path that the previous run never staged) and burns
    // turns inspecting them before getting to the actual work. The clean
    // is gated on `rev-list --count <integration>..HEAD == 0`, so any
    // commits the agent already produced are preserved.
    try {
      const cleanResult = await cleanWorktreeIfNoCommitsAhead({
        worktreePath: inputData.path,
        integrationBranch: inputData.integrationBranch,
      })
      if (cleanResult.cleaned && cleanResult.output.trim().length > 0) {
        console.log(
          `[clean] task ${inputData.taskId} ${cleanResult.reason}\n${cleanResult.output.trim()}`,
        )
      } else if (!cleanResult.cleaned) {
        console.log(
          `[clean] task ${inputData.taskId} skipped: ${cleanResult.reason}`,
        )
      }
    } catch (err) {
      // Clean is a best-effort hygiene step; never fail the dispatch on it.
      console.error(
        `[clean] task ${inputData.taskId} threw, continuing without clean:`,
        err,
      )
    }

    const originId = await resolveOriginIdForTask(inputData.taskId)
    const tag = isTaskTag(inputData.tag) ? inputData.tag : 'coder'
    const fullPrompt = composePrompt(inputData.prompt, inputData.plan, tag)
    const conversation: ClaudeEvent[] = []
    const worker = getWorkerForTag(tag)
    const r = await worker.run(fullPrompt, {
      cwd: inputData.path,
      systemPrompt: tag === 'writer' ? WRITER_SYSTEM_PROMPT : undefined,
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
      tag,
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
    tag: tagSchema,
    claudeExitCode: z.number(),
    resumeFrom: resumeFromSchema,
  }),
  outputSchema: z.object({
    taskId: z.string(),
    integrationBranch: z.string(),
    path: z.string(),
    branch: z.string(),
    tag: tagSchema,
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
        tag: inputData.tag,
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
    // Writer tasks land their changes on the integration branch via the
    // daemon's structured-write path, not on the task branch — so the
    // task branch is correctly 0 commits ahead of integration and the
    // has-diff check would reject a perfectly successful Writer run.
    // Skip has-diff for writer; the typecheck/test/lint gates still apply.
    const r = await verifyChanges({
      cwd: verifyCwd,
      steps,
      branch: inputData.branch,
      integrationBranch: inputData.integrationBranch,
      skipDiffCheck: inputData.tag === 'writer',
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
          // Handler backfills from task.prompt when '' is passed.
          originalPrompt: '',
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
      tag: inputData.tag,
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
    tag: tagSchema,
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

    // Writer short-circuit: the daemon's structured-write path already
    // committed every change on the integration branch, so the task
    // branch is identical to integration and there is nothing to merge.
    // Clean up the worktree and mark the task done; the merge primitive
    // would otherwise contend for the merge lock for a guaranteed no-op.
    if (inputData.tag === 'writer') {
      await removeWorktree({ path: inputData.path, branch: inputData.branch }, true)
      await updateTask(inputData.taskId, { status: 'done', failedPhase: null })
      return {
        taskId: inputData.taskId,
        success: true,
        message: 'writer task: changes landed on integration via structured-write daemon',
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

      const targetStatus = await checkMergeTargetStatus({
        integrationBranch: inputData.integrationBranch,
        taskBranch: inputData.branch,
      })
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
            // Handler backfills from task.prompt when '' is passed.
            originalPrompt: '',
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
    tag: tagSchema,
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
