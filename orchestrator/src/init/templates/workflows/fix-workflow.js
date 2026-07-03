// @mars-workflow-template:v3
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
// single `mars/workflow` surface, and each primitive DEFAULTS its options from
// `ctx.input`. A fix task is dispatched with `ctx.input.kind === 'fix'`, so the
// primitives automatically do the recovery-specific thing: `setupWorktree`
// ATTACHES to the origin's worktree+branch (via `ctx.input.fixForTaskId`) and
// stacks the fix commit there rather than carving a fresh worktree, and
// `runAgent` routes to the Fixer (Sonnet, scoped mechanical recovery). Every primitive
// pulls all plumbing off `ctx`; every task-state write funnels through the Arc
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
  /** @param {WorkflowCtx} ctx */
  async fn(ctx) {
    // setup → attach to the origin worktree (ctx.input.fixForTaskId), install deps.
    await ctx.step('setup', () => setupWorktree(ctx))

    // fix-code → the Fixer (Sonnet) attempts the repair on the origin's branch.
    await ctx.step('fix-code', () => runAgent(ctx))

    await ctx.step('verify', () => verify(ctx))

    return await ctx.step('merge', () => merge(ctx))
  },
})
