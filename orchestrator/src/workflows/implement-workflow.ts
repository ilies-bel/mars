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
  review,
  merge as mergePrimitive,
  type MarsServices,
} from './primitives'
import { behaviourVerify as behaviourVerifyPrimitive } from './primitives/behaviour-verify'

import {
  planSchema,
  tagSchema,
  kindSchema,
  specSchema,
} from './primitives/shared'

// ---------------------------------------------------------------------------
// @mars/workflow implement pipeline (was: four Mastra createStep bodies).
//
// The pipeline is one imperative async function. `ctx.step(name, fn)` wraps
// each durable unit; the four step NAMES are load-bearing
// ('setup-worktree', 'run-claude-code', 'review', 'merge') — they key
// checkpoint-resume and the trace-view node label. Each step body is now a
// thin composition over the corresponding `./primitives` function.
// ---------------------------------------------------------------------------

// Services injected at `runWorkflow` time. The daemon wires
// `{ store, traceStore }` from the composition root; the primitives read
// `store` as the Arc write funnel and `traceStore` for spans/events.
// Re-exported from the primitives module so there is one MarsServices type.
export type { MarsServices }

// Validated workflow input.
export const implementInputSchema = z.object({
  taskId: z.string(),
  prompt: z.string(),
  plan: planSchema.default(null),
  tags: tagSchema,
  kind: kindSchema,
  integrationBranch: z.string().default('main'),
  spec: specSchema,
  /**
   * True when the task is being re-dispatched after a failed attempt with
   * an existing worktree. The code step prepends a resume banner to the coder
   * prompt so the agent reads prior progress before continuing.
   */
  resumeFromPriorAttempt: z.boolean().default(false),
  /** Recorded verify output for a coder that is re-entering after verify failed. */
  verifyFailureOutput: z.string().nullable().default(null),
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
  /**
   * QA mode for the review step. `'auto'` (default) runs every configured
   * typecheck/test/lint gate. `'manual'` parks for human QA (not yet fully
   * implemented — the review primitive throws on `'manual'`).
   * Sourced from `tasks.qa`; defaults to `'auto'` for tasks enqueued
   * before this column existed.
   */
  qa: z.enum(['auto', 'manual']).default('auto'),
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
    // review throws on failure, so reaching merge always means review passed.
    // qa is sourced from the task row (tasks.qa); defaults to 'auto'.
    const qa = ctx.input.qa ?? 'auto'
    await ctx.step('review', () => review(ctx, { reviewType: qa }))
    // Behaviour verification (fifth primitive): exercises the task's
    // Definition of Done against a live surface via Playwright MCP. PASS and
    // CAN'T-VERIFY return (CAN'T-VERIFY files a draft proposal + raises a
    // behaviour-unverified action-queue row first); a behavioural FAIL throws
    // — so reaching merge also means no DoD criterion was observed
    // contradicted on a reached live surface.
    await ctx.step('behaviour-verify', () => behaviourVerifyPrimitive(ctx))
    return await ctx.step('merge', () => mergePrimitive(ctx))
  },
})
