// @mars-workflow-template:v2
//
// fix-workflow.js — the recovery pipeline for a failed task.
//
// SCAFFOLDED by `mars init` into `.mars/workflows/` and USER-OWNED (ADR-0057):
// edit freely. `mars update` shows a diff instead of overwriting your edits.
//
// Recovery tasks are leaf nodes (ADR-0040): exactly one recovery attempt per
// origin failure, no blockers, no retry budget.
//
// Like the task pipeline, a fix COMPOSES the four git step-primitives from the
// single `mars/workflow` surface. With `kind: 'fix'` the primitives do the
// recovery-specific thing automatically: `setupWorktree` ATTACHES to the
// origin's worktree+branch (via `fixForTaskId`) and stacks the fix commit there
// rather than carving a fresh worktree, and `runAgent` routes to the Fixer
// (Opus, recovery resilience). Every primitive takes `(ctx, opts)` and pulls
// all plumbing off `ctx`; every task-state write funnels through the Arc
// aggregate (ADR-0052).

/** @typedef {import('mars/workflow').WorkflowCtx} WorkflowCtx */

import {
  defineWorkflow,
  setupWorktree,
  runAgent,
  verify,
  merge,
} from 'mars/workflow'

export default defineWorkflow({
  id: 'fix',
  /**
   * @param {WorkflowCtx} ctx
   * @param {{
   *   taskId: string,
   *   prompt: string,
   *   plan?: unknown,
   *   tags?: string[],
   *   spec?: unknown,
   *   integrationBranch?: string,
   *   resumeFromCodePhase?: boolean,
   *   recoveryPayload?: string | null,
   *   fixForTaskId?: string | null,
   * }} input
   */
  async fn(ctx, input) {
    // Recovery: kind is always 'fix' for this pipeline.
    const kind = 'fix'

    // setup → attach to the origin worktree (fixForTaskId) and install deps.
    await ctx.step('setup', () =>
      setupWorktree(ctx, {
        kind,
        integrationBranch: input.integrationBranch,
        recoveryPayload: input.recoveryPayload,
        fixForTaskId: input.fixForTaskId,
      }),
    )

    // fix-code → the Fixer (Opus) attempts the repair on the origin's branch.
    await ctx.step('fix-code', () =>
      runAgent(ctx, {
        prompt: input.prompt,
        plan: input.plan,
        tags: input.tags,
        kind,
        spec: input.spec,
        integrationBranch: input.integrationBranch,
        resumeFromCodePhase: input.resumeFromCodePhase,
      }),
    )

    await ctx.step('verify', () =>
      verify(ctx, {
        kind,
        integrationBranch: input.integrationBranch,
        recoveryPayload: input.recoveryPayload,
      }),
    )

    return await ctx.step('merge', () =>
      merge(ctx, { kind, integrationBranch: input.integrationBranch }),
    )
  },
})
