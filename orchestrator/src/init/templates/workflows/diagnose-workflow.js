// @mars-workflow-template:v2
//
// diagnose-workflow.js — read-only diagnosis of a stuck/failed task.
//
// SCAFFOLDED by `mars init` into `.mars/workflows/` and USER-OWNED (ADR-0057):
// edit freely. `mars update` shows a diff instead of overwriting your edits.
//
// Diagnosis proposes no action of its own — it records a structured verdict the
// operator (or the action queue) acts on afterward. It does not yet compose the
// git step-primitives (it has no worktree to verify/merge); the steps below are
// hand-written placeholders for you to flesh out.

/** @typedef {import('mars/workflow').WorkflowCtx} WorkflowCtx */

import { defineWorkflow } from 'mars/workflow'

export default defineWorkflow({
  id: 'diagnose',
  /**
   * @param {WorkflowCtx} ctx
   * @param {{ taskId: string }} input
   */
  async fn(ctx, input) {
    const arc = await ctx.step('walk-arc', async () => {
      // Walk origin -> recovery via fix_for_task_id / origin_id.
      return { taskId: input.taskId }
    })

    const evidence = await ctx.step('collect-evidence', async () => {
      // Pull task prompts, failure signatures, and relevant git history.
      return { arc }
    })

    await ctx.step('record-verdict', async () => {
      // Persist a structured "what happened & why" — root-cause or inconclusive.
      return { evidence }
    })

    return { taskId: input.taskId, status: 'diagnosed' }
  },
})
