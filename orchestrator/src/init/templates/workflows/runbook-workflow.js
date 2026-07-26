// @mars-workflow-template:v1
//
// runbook-workflow.js — a manual-heavy pipeline for operator-driven releases.
//
// This file is SCAFFOLDED by `mars init` into `.mars/workflows/` and is
// USER-OWNED (ADR-0057): edit it freely. `mars update` shows a diff instead
// of silently overwriting your edits.
//
// Shape: setup (auto) → code (auto) → qa (MANUAL) → verify (auto) → merge (auto).
//
// The `qa` step parks the task 'awaiting-human' and renders its Step guide
// in the action queue. You review the diff, run any manual smoke tests, tick
// done-criteria with `mars task check`, then signal completion with
// `mars step done <id>`. The automated verify and merge gates run immediately.
//
// Route a task here with `mars task add --workflow runbook "<prompt>"`.
// Check the declared runbook at any time: `mars workflow validate runbook`
// (edits go live on the next dispatch without a daemon restart; a broken file
// fails the task rather than silently falling back).

/** @typedef {import('mars/workflow').WorkflowCtx} WorkflowCtx */

import {
  defineWorkflow,
  setupWorktree,
  runAgent,
  verify,
  merge,
} from 'mars/workflow'

export default defineWorkflow({
  id: 'runbook',
  /** @param {WorkflowCtx} ctx */
  async fn(ctx) {
    // setup → auto: provision the worktree on `task/<id>` and install deps.
    await ctx.step('setup', () => setupWorktree(ctx))

    // code → auto: the coder implements the task prompt inside the worktree.
    await ctx.step('code', () => runAgent(ctx, { mode: 'auto' }))

    // qa → MANUAL: you review the diff and run smoke tests before automated
    // verify. The Step guide is shown in the action queue.
    // Tick criteria with `mars task check <id> <criterion>`, then signal
    // completion with `mars step done <id>`.
    await ctx.step('qa', () =>
      runAgent(ctx, {
        mode: 'manual',
        guide:
          'Review the diff in your editor. Run any manual smoke tests. ' +
          'Tick done-criteria with `mars task check`, commit fixes if needed, ' +
          'then run `mars step done` to proceed to automated verify.',
      }),
    )

    // verify → auto: scope-aware typecheck → tests → lint. Same gates that
    // bind agents bind operators — the pipeline enforces correctness for both.
    await ctx.step('verify', () => verify(ctx, { mode: 'auto' }))

    // merge → auto: serialized fast-forward into the integration branch.
    return await ctx.step('merge', () => merge(ctx))
  },
})
