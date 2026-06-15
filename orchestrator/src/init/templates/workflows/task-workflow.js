// @mars-workflow-template:v2
//
// task-workflow.js — the default end-to-end task pipeline.
//
// This file is SCAFFOLDED by `mars init` into `.mars/workflows/` and is
// USER-OWNED (ADR-0057): edit it freely to author your own flow. `mars update`
// will never silently overwrite it — when the bundled template changes it shows
// you a diff and lets you merge by hand.
//
// EVERYTHING is imported from the single `mars/workflow` surface: the
// `defineWorkflow` definition helper AND the four git step-primitives
// (`setupWorktree`, `runAgent`, `verify`, `merge`). Each primitive takes
// `(ctx, opts)` — `ctx` is the run context the engine hands you, and `opts` is
// a small bag of per-call options that all default. You never touch the
// plumbing: the Arc task store, the trace store, the worktree ref, the event
// sink, and the step handle are all pulled off `ctx` for you (the worktree
// `setupWorktree` provisions is remembered for `verify`/`merge`). Every
// task-state write still funnels through the Arc aggregate (ADR-0052), so this
// workflow CANNOT strand a task.

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
  /**
   * @param {WorkflowCtx} ctx
   * @param {{
   *   taskId: string,
   *   prompt: string,
   *   plan?: unknown,
   *   tags?: string[],
   *   kind?: 'task' | 'fix' | 'diagnose',
   *   spec?: unknown,
   *   integrationBranch?: string,
   *   resumeFromCodePhase?: boolean,
   *   recoveryPayload?: string | null,
   *   fixForTaskId?: string | null,
   * }} input
   */
  async fn(ctx, input) {
    const kind = input.kind ?? 'task'

    // setup → provision/attach the worktree on `task/<id>` and install deps.
    // The resolved worktree is remembered on `ctx` for verify/merge below.
    await ctx.step('setup', () =>
      setupWorktree(ctx, {
        kind,
        integrationBranch: input.integrationBranch,
        recoveryPayload: input.recoveryPayload,
        fixForTaskId: input.fixForTaskId,
      }),
    )

    // code → the coder implements the task prompt inside the worktree.
    await ctx.step('code', () =>
      runAgent(ctx, {
        prompt: input.prompt,
        plan: input.plan,
        tags: input.tags,
        kind,
        spec: input.spec,
        integrationBranch: input.integrationBranch,
        resumeFromCodePhase: input.resumeFromCodePhase,
      }),
    )

    // verify → scope-aware typecheck → tests → lint. Throws on any failure.
    await ctx.step('verify', () =>
      verify(ctx, {
        kind,
        integrationBranch: input.integrationBranch,
        recoveryPayload: input.recoveryPayload,
      }),
    )

    // merge → serialized fast-forward into the integration branch (Vega on conflict).
    return await ctx.step('merge', () =>
      merge(ctx, { kind, integrationBranch: input.integrationBranch }),
    )
  },
})
