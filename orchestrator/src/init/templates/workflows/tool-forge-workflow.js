// @mars-workflow-template:v1
//
// tool-forge-workflow.js — benchmark-gated helper generation pipeline.
//
// Dispatched when the failure-signature detector identifies a recurring
// missing-helper pattern and enqueues a task to create the helper + benchmark.
//
// This file is SCAFFOLDED by `mars init` into `.mars/workflows/` and is
// USER-OWNED (ADR-0057): edit it freely to author your own flow. `mars update`
// will never silently overwrite it — when the bundled template changes it shows
// you a diff and lets you merge by hand.
//
// The coder prompt (built by `buildToolForgePrompt` in
// `orchestrator/src/workflows/tool-forge-workflow.ts`) instructs the coder to:
//   (a) create orchestrator/src/tools/<helperKey>/index.ts
//   (b) create orchestrator/benchmarks/<helperKey>.bench.ts that replays each
//       motivating arc id
//
// The verify step runs the benchmark twice (with and without the helper) using
// whatever verifyCmd the task spec declares.

/** @typedef {import('mars/workflow').WorkflowCtx} WorkflowCtx */

import {
  defineWorkflow,
  setupWorktree,
  runAgent,
  verify,
  merge,
} from 'mars/workflow'

export default defineWorkflow({
  id: 'tool-forge',
  /** @param {WorkflowCtx} ctx */
  async fn(ctx) {
    // setup → provision/attach the worktree on `task/<id>` and install deps.
    await ctx.step('setup', () => setupWorktree(ctx))

    // code → the coder creates the helper module and benchmark file.
    await ctx.step('code', () => runAgent(ctx, { mode: 'auto' }))

    // verify → runs the task's verifyCmd (expected to exercise the benchmark
    // with and without the helper to confirm correctness in both configurations).
    await ctx.step('verify', () => verify(ctx, { mode: 'auto' }))

    // merge → serialized fast-forward into the integration branch.
    return await ctx.step('merge', () => merge(ctx))
  },
})
