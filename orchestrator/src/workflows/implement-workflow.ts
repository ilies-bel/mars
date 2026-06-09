import { defineWorkflow, type StepHandle, type WorkflowCtx } from '@mars/workflow'
import { z } from 'zod'

import { nullTraceStore } from '../core/lib/run-tool'
import { resolveContext } from '../core/context'
import type { ClaudeEvent } from '../core/lib/claude-stream'
import { resolveOriginIdForTask } from '../core/lib/origin'
import { type DomainTaskStore as TaskStore } from '../core/store/task-store'
import { openTraceEventStore, type TraceEventStore } from '../core/lib/trace-events-store'

// ── ADR-0056 git step-primitive surface ────────────────────────────────────
// The four reusable primitives now live in `./primitives`. The bundled
// implement pipeline below is one composition over them; scaffolded
// `.mars/workflows/*.js` files import the same primitives. Every task-state
// write inside a primitive routes through the injected Arc-backed `store`
// (ADR-0052), so neither this workflow nor a custom one can strand a task.
import {
  setupWorktree,
  runAgent,
  verify as verifyPrimitive,
  merge as mergePrimitive,
  type PrimitiveTraceArgs,
} from './primitives'

// Pure helpers + failure sentinels were hoisted to `./primitives/shared` so the
// primitive surface can reuse them without importing this module back. They are
// re-exported here UNCHANGED so existing call sites (daemon dispatch, tests,
// slicer) keep importing them from `./implement-workflow`.
import {
  planSchema,
  tagSchema,
  kindSchema,
  specSchema,
} from './primitives/shared'

export {
  // Failure sentinels (message builders + detectors)
  BLOCKERS_ABORT_MESSAGE,
  isBlockersAbortError,
  MAIN_DIRTY_VERIFY_MESSAGE,
  isMainDirtyVerifyError,
  CONTEXT_EXHAUSTED_ABORT_MESSAGE,
  isContextExhaustedAbortError,
  ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE,
  isOriginWorktreeMissingAbortError,
  // Prompt briefs + system-prompt assembly
  COMMIT_FOOTER,
  DEVIATION_RULES,
  CODING_DISCIPLINE,
  CODER_SYSTEM_PROMPT,
  buildCoderSystemPrompt,
  resolveWorkerSystemPrompt,
  pickWorkerForTask,
  recoveryAttachesToOrigin,
  // Prompt composition + classifiers
  composePrompt,
  failureExcerpt,
  detectPostCoderState,
} from './primitives/shared'
export type { PostCoderStateArgs, PostCoderState } from './primitives/shared'

// ---------------------------------------------------------------------------
// @mars/workflow implement pipeline (was: four Mastra createStep bodies).
//
// The pipeline is one imperative async function. `ctx.step(name, fn)` wraps
// each durable unit; the four step NAMES are load-bearing and unchanged
// ('setup-worktree', 'run-claude-code', 'verify', 'merge') — they key
// checkpoint-resume and the trace-view node label. Each step body is now a
// thin composition over the corresponding `./primitives` function.
// ---------------------------------------------------------------------------

// Services injected at `runWorkflow` time. The daemon wires `{ store: TaskStore }`
// from the composition root; the primitives read it as the Arc write funnel.
export interface ImplementServices {
  store: TaskStore
}

// Validated workflow input.
const implementInputSchema = z.object({
  taskId: z.string(),
  prompt: z.string(),
  plan: planSchema.default(null),
  tags: tagSchema,
  kind: kindSchema,
  integrationBranch: z.string().default('main'),
  spec: specSchema,
  /**
   * True when the task is being re-dispatched after a code-phase failure with
   * an existing worktree. The code step prepends a resume banner to the coder
   * prompt so the agent reads prior progress before continuing.
   */
  resumeFromCodePhase: z.boolean().default(false),
  /**
   * JSON-serialised recovery payload from `tasks.recovery_payload`. Present
   * only on `kind='fix'` tasks.
   */
  recoveryPayload: z.string().nullable().default(null),
  /**
   * The origin task this recovery is recovering (`tasks.fix_for_task_id`).
   * Non-null only on `kind='fix'` tasks.
   */
  fixForTaskId: z.string().nullable().default(null),
})

export type ImplementInput = z.infer<typeof implementInputSchema>

export interface ImplementOutput {
  taskId: string
  success: boolean
  message: string
}

export const implementWorkflow = defineWorkflow<
  ImplementInput,
  ImplementOutput,
  ImplementServices
>({
  id: 'implement',
  inputSchema: implementInputSchema,
  fn: async (
    ctx: WorkflowCtx<ImplementServices>,
    input: ImplementInput,
  ): Promise<ImplementOutput> => {
    const store = ctx.services.store

    // One trace store for every shell-out across all four phases. Opened once;
    // failure to open is non-fatal (nullTraceStore drops events silently).
    const workflowTraceStore: TraceEventStore =
      (await openTraceEventStore(resolveContext().stateDbPath).catch(() => undefined)) ??
      nullTraceStore
    // Resolve origin id once for stable trace attribution across the workflow.
    const workflowOriginId = await resolveOriginIdForTask(input.taskId).catch(
      () => input.taskId,
    )
    const trace: PrimitiveTraceArgs = {
      workflowInstanceId: ctx.runId,
      originId: workflowOriginId,
      traceStore: workflowTraceStore,
    }

    // ── setup-worktree ─────────────────────────────────────────────────────
    const worktree = await ctx.step(
      'setup-worktree',
      (handle: StepHandle) =>
        setupWorktree({
          taskId: input.taskId,
          integrationBranch: input.integrationBranch,
          kind: input.kind,
          recoveryPayload: input.recoveryPayload,
          fixForTaskId: input.fixForTaskId,
          store,
          trace,
          handle,
        }),
    )

    // ── run-claude-code ─────────────────────────────────────────────────────
    await ctx.step('run-claude-code', (handle: StepHandle) =>
      runAgent({
        taskId: input.taskId,
        prompt: input.prompt,
        plan: input.plan,
        tags: input.tags,
        kind: input.kind,
        spec: input.spec ?? null,
        integrationBranch: input.integrationBranch,
        resumeFromCodePhase: input.resumeFromCodePhase,
        worktree,
        store,
        trace,
        emit: (event: ClaudeEvent) => ctx.emit('claude-event', event),
        handle,
      }),
    )

    // ── verify ───────────────────────────────────────────────────────────
    await ctx.step('verify', () =>
      verifyPrimitive({
        taskId: input.taskId,
        kind: input.kind,
        integrationBranch: input.integrationBranch,
        recoveryPayload: input.recoveryPayload,
        worktree,
        store,
        trace,
      }),
    )

    // ── merge ──────────────────────────────────────────────────────────────
    // verify throws on failure, so reaching here always means verify passed.
    return await ctx.step('merge', () =>
      mergePrimitive({
        taskId: input.taskId,
        kind: input.kind,
        integrationBranch: input.integrationBranch,
        worktree,
        store,
        trace,
        emit: (event: ClaudeEvent) => ctx.emit('vcs-supervisor-event', event),
      }),
    )
  },
})
