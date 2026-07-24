// @mars-workflow-template:v4
//
// report-workflow.js — read-only report pipeline.
//
// This pipeline is READ-ONLY: no commits are required, no verify runs,
// and no merge is attempted. Use it for tasks that produce a structured
// report or analysis (documentation generation, audits, research summaries)
// where the output lives in the agent's response rather than in a committed
// diff.
//
// SCAFFOLDED by `mars init` into `.mars/workflows/` and USER-OWNED (ADR-0057):
// edit freely. `mars update` shows a diff instead of overwriting your edits.
//
// All primitives are imported from the single `mars/workflow` surface:
//   - `setupWorktree` provisions a scratch worktree for read-only agent use.
//   - `runAgent` runs the coder against the task prompt.
//   - `finalizeReport` persists the agent's structured output to the task
//     record and closes the pipeline without a verify or merge step.
//
// Steps: setup → code → finalize  (NO verify, NO merge)

/** @typedef {import('mars/workflow').WorkflowCtx} WorkflowCtx */

import { defineWorkflow, setupWorktree, runAgent, finalizeReport } from 'mars/workflow'

export default defineWorkflow({
  id: 'report',
  /** @param {WorkflowCtx} ctx */
  async fn(ctx) {
    // setup → provision/attach a scratch worktree for read-only agent use.
    // The worktree is available to the agent for reading the codebase;
    // no commit is expected from the agent in this pipeline.
    await ctx.step('setup', () => setupWorktree(ctx))

    // code → the agent reads the codebase and produces a report.
    // Execution mode: auto. Override the model per step if needed:
    //   runAgent(ctx, { model: 'claude-opus-4-7' })
    await ctx.step('code', () => runAgent(ctx, { mode: 'auto' }))

    // finalize → persist the agent's output to the task record and close.
    // No verify runs, no merge is attempted — the pipeline ends here.
    return await ctx.step('finalize', () => finalizeReport(ctx))
  },
})
