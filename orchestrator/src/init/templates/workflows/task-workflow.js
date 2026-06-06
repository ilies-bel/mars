// @mars-workflow-template:v1
//
// task-workflow.js — the default end-to-end task pipeline.
//
// This file is SCAFFOLDED by `mars init` into `.mars/workflows/` and is
// USER-OWNED (ADR-0057): edit it freely to author your own flow. `mars update`
// will never silently overwrite it — when the bundled template changes it shows
// you a diff and lets you merge by hand.
//
// A workflow is a plain JS module exporting a `defineWorkflow({ id, fn })`
// object. `ctx.step(name, fn)` wraps each durable unit; failures THROW.

/** @typedef {import('@mars/workflow').WorkflowCtx} WorkflowCtx */

export default {
  id: 'task',
  /**
   * @param {WorkflowCtx} ctx
   * @param {{ taskId: string, prompt: string }} input
   */
  async fn(ctx, input) {
    await ctx.step('setup', async () => {
      // Worktree on `task/<id>` off the integration branch is provisioned by
      // the orchestrator before this workflow runs. Customise pre-flight here.
      return { taskId: input.taskId }
    })

    await ctx.step('code', async () => {
      // The coder (headless `claude -p`) implements the task prompt.
      return { prompt: input.prompt }
    })

    await ctx.step('verify', async () => {
      // typecheck -> tests -> lint. Reject on any required-step failure.
      return { verified: true }
    })

    await ctx.step('merge', async () => {
      // Serialized fast-forward into the integration branch via the merge lock.
      return { merged: true }
    })

    return { taskId: input.taskId, status: 'done' }
  },
}
