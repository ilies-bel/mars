// @mars-workflow-template:v5
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
//   - `finalizeReport` closes the pipeline without a verify or merge step.
//     Pass `reportText` to persist the agent's findings as a task progress
//     note (readable via `mars task show <id>` / Arc.listProgress).
//
// IMPORTANT — file writes do NOT survive this pipeline. The worktree is
// reclaimed by `finalizeReport`. The agent's brief already tells it to
// return all findings as text in its final response. If you intercept the
// agent's output text (e.g. by extending runAgent or via a custom step),
// pass it as `finalizeReport(ctx, { reportText: agentOutputText })` so the
// findings are persisted to the task record and reachable without decompressing
// the transcript blob.
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
    // The agent brief instructs it to return all findings as text in its
    // final response — file writes inside the worktree do NOT survive.
    // runAgent returns { reportText } — the agent's final output text,
    // extracted from the conversation. Pass it to finalizeReport so the
    // findings are persisted to the task record and survive worktree removal.
    // Override the model per step if needed:
    //   runAgent(ctx, { model: 'claude-opus-5' })
    const { reportText } = await ctx.step('code', () => runAgent(ctx))

    // finalize → persist the agent's findings, reclaim the worktree, and
    // mark the task done. reportText (from the code step above) is persisted
    // as a task progress note readable via `mars task show <id>`.
    // No verify runs, no merge is attempted — the pipeline ends here.
    // Pass reportText: undefined (omit the key) only for a legitimately empty
    // audit where the agent found nothing worth noting.
    return await ctx.step('finalize', () => finalizeReport(ctx, { reportText }))
  },
})
