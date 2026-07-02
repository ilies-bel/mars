import { defineWorkflow } from '@mars/workflow'
import { z } from 'zod'

// ── ADR-0056 git step-primitive surface ────────────────────────────────────
// The four reusable primitives now live in `./primitives`. The bundled
// implement pipeline below is one composition over them; scaffolded
// `.mars/workflows/*.js` files import the same primitives (via `mars/workflow`).
// Every task-state write inside a primitive routes through `ctx.services.store`
// (ADR-0052), so neither this workflow nor a custom one can strand a task. The
// primitives now take `(ctx, opts)` and pull store / trace / worktree / emit /
// handle off `ctx` themselves — this pipeline is the canonical example of the
// authoring API.
import {
  setupWorktree,
  runAgent,
  verify as verifyPrimitive,
  merge as mergePrimitive,
  type MarsServices,
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
  MAIN_DIRTY_MERGE_MESSAGE,
  isMainDirtyMergeError,
  CONTEXT_EXHAUSTED_ABORT_MESSAGE,
  isContextExhaustedAbortError,
  ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE,
  isOriginWorktreeMissingAbortError,
  CODER_EXIT_NONZERO_ABORT_MESSAGE,
  isCoderExitNonzeroAbortError,
  CODER_UNCOMMITTED_ABORT_MESSAGE,
  isCoderUncommittedAbortError,
  PREVIEW_GATE_MESSAGE,
  isPreviewGateError,
  AWAIT_HUMAN_MESSAGE,
  isAwaitHumanError,
  extractAwaitHumanStepName,
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

// Services injected at `runWorkflow` time. The daemon wires
// `{ store, traceStore }` from the composition root; the primitives read
// `store` as the Arc write funnel and `traceStore` for spans/events.
// Re-exported from the primitives module so there is one MarsServices type.
export type { MarsServices }

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
  MarsServices
>({
  id: 'implement',
  inputSchema: implementInputSchema,
  fn: async (ctx): Promise<ImplementOutput> => {
    // Every primitive defaults its options from `ctx.input` (the parsed
    // ImplementInput) and pulls all plumbing — store / trace / worktree / emit
    // / handle — off `ctx`. So each step is just `primitive(ctx)`; the worktree
    // `setup-worktree` provisions is memoised on `ctx` for verify/merge. The
    // four step NAMES stay load-bearing (checkpoint-resume + trace labels).
    await ctx.step('setup-worktree', () => setupWorktree(ctx))
    await ctx.step('run-claude-code', () => runAgent(ctx))
    // verify throws on failure, so reaching merge always means verify passed.
    await ctx.step('verify', () => verifyPrimitive(ctx))
    return await ctx.step('merge', () => mergePrimitive(ctx))
  },
})
