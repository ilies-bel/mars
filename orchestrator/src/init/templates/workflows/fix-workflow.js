// @mars-workflow-template:v1
//
// fix-workflow.js — the recovery pipeline for a failed task.
//
// SCAFFOLDED by `mars init` into `.mars/workflows/` and USER-OWNED (ADR-0057):
// edit freely. `mars update` shows a diff instead of overwriting your edits.
//
// Recovery tasks are leaf nodes (ADR-0040): exactly one recovery attempt per
// origin failure, no blockers, no retry budget.

/** @typedef {import('@mars/workflow').WorkflowCtx} WorkflowCtx */

export default {
  id: 'fix',
  /**
   * @param {WorkflowCtx} ctx
   * @param {{ taskId: string, originId: string, failureReason: string }} input
   */
  async fn(ctx, input) {
    await ctx.step('diagnose-failure', async () => {
      // Inspect the origin failure signature before attempting a fix.
      return { originId: input.originId, failureReason: input.failureReason }
    })

    await ctx.step('fix-code', async () => {
      // The fixer (Opus, for recovery resilience) attempts the repair.
      return { taskId: input.taskId }
    })

    await ctx.step('verify', async () => {
      return { verified: true }
    })

    await ctx.step('merge', async () => {
      return { merged: true }
    })

    return { taskId: input.taskId, status: 'done' }
  },
}
