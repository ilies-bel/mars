// @mars-workflow-template:v4
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
  review,
  merge,
} from 'mars/workflow'

export default defineWorkflow({
  id: 'task',
  /** @param {WorkflowCtx} ctx */
  async fn(ctx) {
    // setup → provision/attach the worktree on `task/<id>` and install deps.
    // The resolved worktree is remembered on `ctx` for verify/merge below.
    // setupWorktree is always auto (no mode override needed).
    await ctx.step('setup', () => setupWorktree(ctx))

    // code → the coder implements the task prompt inside the worktree.
    // Execution mode: auto. Override the model per step like the Agent SDK:
    //   runAgent(ctx, { model: 'claude-opus-4-7' })
    await ctx.step('code', () => runAgent(ctx, { mode: 'auto' }))

    // verify → scope-aware typecheck → tests → lint. Execution mode: auto.
    await ctx.step('verify', () => review(ctx, { reviewType: 'auto' }))

    // ── Manual steps (optional) ──────────────────────────────────────────
    // Every step declares WHO executes it: auto (an agent — the default) or
    // manual (you, in your own session). A manual step parks the task
    // 'awaiting-human' with its Step guide in the action queue;
    // `mars step done <id>` completes the step and the pipeline continues
    // (re-parking at the next manual step re-leases you automatically).
    //
    // Example manual QA gate — uncomment and insert before merge:
    //
    //   await ctx.step('qa', () =>
    //     runAgent(ctx, {
    //       mode: 'manual',
    //       guide:
    //         'Open the diff in your editor and confirm the change is correct. ' +
    //         'Tick criteria with `mars task check`, then run `mars step done`.',
    //     }),
    //   )
    //
    // For fully human-driven coding, route tasks to the live workflow
    // instead: `mars task add --live "<prompt>"` (see live-workflow.js).
    // After editing this file, check it: `mars workflow validate task` —
    // edits go live on the next dispatch, and a broken file fails the task
    // rather than silently running a different pipeline.

    // merge → serialized fast-forward into the integration branch (Vega on conflict).
    return await ctx.step('merge', () => merge(ctx))
  },
})
