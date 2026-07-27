// @mars-workflow-template:v1
//
// live-workflow.js — the live pipeline: YOU drive the code step.
//
// This file is SCAFFOLDED by `mars init` into `.mars/workflows/` and is
// USER-OWNED (ADR-0057): edit it freely. `mars update` never silently
// overwrites it — when the bundled template changes it shows you a diff.
//
// Route a task here with `mars task add --live "<prompt>"` (sugar for
// `--workflow live`). The flow:
//
//   1. setup runs auto — the daemon provisions the worktree on task/<id>.
//   2. The task parks 'awaiting-human' at the MANUAL code step. The action
//      queue shows the Step guide. Work in the worktree.
//   3. Journal decisions with `mars task note`, tick criteria with
//      `mars task check`, commit as you go.
//   4. `mars step done <id>` completes the step. verify and merge then gate
//      your work exactly as they gate an agent's. If the pipeline parks at
//      another manual step later, the same lease is re-granted automatically.
//      `mars release <id> --abort` bails to the failure path at any point.
//
// Iterating on this file: edits go live on the NEXT dispatch — no daemon
// restart. A broken file NEVER silently falls back to another pipeline; the
// task fails with the validator's message instead. Check yourself anytime:
//
//   mars workflow validate live
//
// Hybrids are yours to compose: flip verify to manual for hand-QA
// (`review(ctx, { reviewType: 'manual', guide: '...' })`), add more manual stages,
// or copy this file to <name>-workflow.js for a new pipeline and route tasks
// with `mars task add --workflow <name>`.

/** @typedef {import('mars/workflow').WorkflowCtx} WorkflowCtx */

import {
  defineWorkflow,
  setupWorktree,
  runAgent,
  review,
  merge,
} from 'mars/workflow'

export default defineWorkflow({
  id: 'live',
  /** @param {WorkflowCtx} ctx */
  async fn(ctx) {
    // setup → auto: provision the worktree on `task/<id>` and install deps.
    await ctx.step('setup', () => setupWorktree(ctx))

    // code → MANUAL: a Foreground session implements this step. The guide is
    // what the action queue and the session hooks show you.
    await ctx.step('code', () =>
      runAgent(ctx, {
        mode: 'manual',
        guide:
          'Implement the task in this worktree. Journal decisions with `mars task note`, tick done-criteria with `mars task check`, commit as you go, then run `mars step done`.',
      }),
    )

    // verify → auto: scope-aware typecheck → tests → lint. The same gates
    // that bind Workers bind humans.
    await ctx.step('verify', () => review(ctx))

    // merge → auto: serialized fast-forward into the integration branch.
    return await ctx.step('merge', () => merge(ctx))
  },
})
