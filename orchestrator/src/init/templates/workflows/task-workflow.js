// @mars-workflow-template:v3
//
// task-workflow.js — the default end-to-end task pipeline.
//
// This file is SCAFFOLDED by `mars init` into `.mars/workflows/` and is
// USER-OWNED (ADR-0057): edit it freely to author your own flow. `mars update`
// will never silently overwrite it — when the bundled template changes it shows
// you a diff and lets you merge by hand.
//
// EVERYTHING is imported from the single `mars/workflow` surface: the
// `defineWorkflow` helper AND the four git step-primitives (`setupWorktree`,
// `runAgent`, `verify`, `merge`). Each primitive takes `(ctx, opts?)` and
// DEFAULTS every option from `ctx.input` — the dispatch facts the daemon ran
// this task with (prompt, kind, branch, recovery payload, …). So a step is just
// `primitive(ctx)`. You pass an options bag ONLY to override a field, e.g.
// `runAgent(ctx, { model: 'claude-opus-4-7' })`.
//
// You never touch the plumbing: the Arc task store, the trace store, the
// worktree ref, the event sink, and the step handle are all pulled off `ctx`
// for you (the worktree `setupWorktree` provisions is remembered for
// `verify`/`merge`). Every task-state write still funnels through the Arc
// aggregate (ADR-0052), so this workflow CANNOT strand a task.

/** @typedef {import('mars/workflow').WorkflowCtx} WorkflowCtx */

import {
  defineWorkflow,
  setupWorktree,
  runAgent,
  verify,
  merge,
} from 'mars/workflow'

export default defineWorkflow({
  id: 'task',
  /** @param {WorkflowCtx} ctx */
  async fn(ctx) {
    // setup → provision/attach the worktree on `task/<id>` and install deps.
    // The resolved worktree is remembered on `ctx` for verify/merge below.
    await ctx.step('setup', () => setupWorktree(ctx))

    // code → the coder implements the task prompt inside the worktree.
    // Override the model per step like the Agent SDK's { prompt, model }:
    //   runAgent(ctx, { model: 'claude-opus-4-7' })
    await ctx.step('code', () => runAgent(ctx))

    // verify → scope-aware typecheck → tests → lint. Throws on any failure.
    await ctx.step('verify', () => verify(ctx))

    // merge → serialized fast-forward into the integration branch (Vega on conflict).
    return await ctx.step('merge', () => merge(ctx))
  },
})
