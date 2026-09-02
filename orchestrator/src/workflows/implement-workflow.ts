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
  awaitHuman,
  type MarsServices,
} from './primitives'
import { behaviourVerify as behaviourVerifyPrimitive } from './primitives/behaviour-verify'

import {
  planSchema,
  tagSchema,
  kindSchema,
  specSchema,
} from './primitives/shared'

import { loadDaemonConfig, DEFAULT_VERIFY_PARAMS } from '../core/daemon/config'

// ---------------------------------------------------------------------------
// @mars/workflow implement pipeline (was: four Mastra createStep bodies).
//
// The pipeline is one imperative async function. `ctx.step(name, fn)` wraps
// each durable unit; the four step NAMES are load-bearing
// ('setup-worktree', 'run-agent', 'review', 'merge') — they key
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

// ---------------------------------------------------------------------------
// Verify-step config helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective verify command for the review step.
 *
 * Priority:
 * 1. If the task spec carries an explicit verify command (`spec.verifyCmd`),
 *    use it unchanged — the per-task operator override wins.
 * 2. If the daemon config's `verify.scope` has been tuned away from the
 *    default wildcard (`DEFAULT_VERIFY_PARAMS.scope === '*'`), generate a
 *    scoped command so the scope lever actually changes what the review step
 *    runs when the task provides no explicit command.
 * 3. Otherwise return null — the review step runs its configured gate steps
 *    with no additional spec-level command.
 *
 * The arguments mirror the two config sources consumed at call-time so the
 * function is pure and testable without disk access. Callers pass
 * `ctx.input.spec?.verifyCmd ?? null` and `loadDaemonConfig().verify.scope`.
 */
export const resolveEffectiveVerifyCmd = (
  specVerifyCmd: string | null,
  scope: string,
): string | null => {
  if (specVerifyCmd !== null) return specVerifyCmd
  // DEFAULT_VERIFY_PARAMS.scope === '*' is the "no scope restriction" sentinel.
  // Only synthesise a default command when the operator has explicitly overridden
  // the scope to something more specific.
  if (scope !== DEFAULT_VERIFY_PARAMS.scope) return `npx vitest run ${scope}`
  return null
}

/**
 * Identifier for the code step (run-agent) within the implement workflow.
 *
 * Code-step levers — `code.context-strategy`, `code.tool-exposure`, and
 * `code.prompt-prefix` — in lever-registry.ts declare this as their consumer
 * symbol so the build-enforcing test can verify the wiring exists. The
 * `promptPrefix` lever is wired in the workflow fn below (prepended to the
 * coder prompt at dispatch time). `contextStrategy` and `toolExposure` are
 * read from daemon config at dispatch time and their wiring into RunAgentOpts
 * is tracked in future slices 7–9 of PRD 8e15a3f5.
 */
export const codeStep = 'run-agent' as const

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

    // ── Code step — read code-step lever config at dispatch time ────────────
    // Config is read inside the workflow fn (not at module load) so a daemon
    // config update between tasks is picked up without a restart.
    const {
      contextStrategy: _contextStrategy,
      toolExposure: _toolExposure,
      promptPrefix,
    } = loadDaemonConfig().code
    // _contextStrategy: context assembly strategy wiring (full/filtered/minimal)
    // into RunAgentOpts is tracked in future slices 7–8 of PRD 8e15a3f5 —
    // RunAgentOpts does not yet expose a context-strategy knob.
    // _toolExposure: tool-set allow/deny filtering is tracked in future slice 9
    // — RunAgentOpts does not yet accept a tool-exposure field.
    // promptPrefix IS wired: non-empty values are prepended to the coder prompt
    // so the operator's house-style reminder leads every dispatch.
    await ctx.step('run-agent', () =>
      runAgent(ctx, {
        prompt: promptPrefix
          ? `${promptPrefix}\n\n${ctx.input.prompt}`
          : ctx.input.prompt,
      }),
    )

    // ── Verify step — read verify-step lever config at dispatch time ─────────
    const { scope, gateTimeoutMs: _gateTimeoutMs } = loadDaemonConfig().verify
    // _gateTimeoutMs: per-gate timeout wiring into the review primitive is
    // tracked in a future slice — ReviewOpts does not yet accept a
    // gateTimeoutMs field. The value is read here so it is observable in
    // traces when the field is eventually wired.
    // scope IS wired via resolveEffectiveVerifyCmd: when the operator has set a
    // non-default scope, a scoped fallback verify command is synthesised and
    // passed to the review step as a spec override (only when the task itself
    // has no explicit verifyCmd).
    const effectiveVerifyCmd = resolveEffectiveVerifyCmd(
      ctx.input.spec?.verifyCmd ?? null,
      scope,
    )
    const effectiveSpec =
      ctx.input.spec != null
        ? { ...ctx.input.spec, verifyCmd: effectiveVerifyCmd }
        : null

    // review throws on failure, so reaching merge always means review passed.
    // qa is sourced from the task row (tasks.qa); defaults to 'auto'.
    const qa = ctx.input.qa ?? 'auto'
    await ctx.step('review', () => review(ctx, { reviewType: qa, spec: effectiveSpec }))
    // Behaviour verification (fifth primitive): exercises the task's
    // Definition of Done against a live surface via Playwright MCP. PASS and
    // CAN'T-VERIFY return (CAN'T-VERIFY files a draft proposal + raises a
    // behaviour-unverified action-queue row first); a behavioural FAIL throws
    // — so reaching merge also means no DoD criterion was observed
    // contradicted on a reached live surface.
    await ctx.step('behaviour-verify', () => behaviourVerifyPrimitive(ctx))
    // Gate: if the task's merge_mode is 'gated', park for human approval
    // before the merge step. The awaitHuman primitive transitions the task to
    // 'awaiting-human', raises an action-queue row, and suspends the step
    // until `mars step done <id>` resolves it — the step then completes
    // normally and the run falls straight through to merge. If the daemon
    // dies while suspended, the operator's `step done` patches the merge-gate
    // step to 'completed' and the engine short-circuits it on re-dispatch.
    if ((ctx.input.spec?.mergeMode ?? 'auto') === 'gated') {
      await ctx.step('merge-gate', () =>
        awaitHuman(ctx, {
          note:
            'Task is merge_mode=gated. Review the changes in the worktree, ' +
            'then `mars step done <id>` to approve and merge.',
        }),
      )
    }
    return await ctx.step('merge', () => mergePrimitive(ctx))
  },
})
