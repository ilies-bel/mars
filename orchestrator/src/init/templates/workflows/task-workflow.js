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
//
// The four steps COMPOSE the orchestrator's exported git step-primitives
// (ADR-0056): `setupWorktree`, `runAgent`, `verify`, `merge`. They are imported
// from `mars/workflow-primitives` — the stable seam the orchestrator publishes
// for exactly this. Each primitive routes every task-state write through the
// injected Arc store (`ctx.services.store`, ADR-0052), so this custom workflow
// CANNOT strand a task or bypass the aggregate — the funnel is baked in.

/** @typedef {import('@mars/workflow').WorkflowCtx} WorkflowCtx */

import {
  buildPrimitiveTrace,
  setupWorktree,
  runAgent,
  verify,
  merge,
} from 'mars/workflow-primitives'

export default {
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
    const store = ctx.services.store
    const integrationBranch = input.integrationBranch ?? 'main'
    const kind = input.kind ?? 'task'
    // One trace context for the whole run (spans + git shell-out attribution).
    const trace = await buildPrimitiveTrace(ctx.runId, input.taskId)

    // setup → provision/attach the worktree on `task/<id>` and install deps.
    const worktree = await ctx.step('setup', (handle) =>
      setupWorktree({
        taskId: input.taskId,
        integrationBranch,
        kind,
        recoveryPayload: input.recoveryPayload ?? null,
        fixForTaskId: input.fixForTaskId ?? null,
        store,
        trace,
        handle,
      }),
    )

    // code → the coder (headless `claude -p`) implements the task prompt.
    await ctx.step('code', (handle) =>
      runAgent({
        taskId: input.taskId,
        prompt: input.prompt,
        plan: input.plan ?? null,
        tags: input.tags ?? ['coder'],
        kind,
        spec: input.spec ?? null,
        integrationBranch,
        resumeFromCodePhase: input.resumeFromCodePhase ?? false,
        worktree,
        store,
        trace,
        emit: (event) => ctx.emit('claude-event', event),
        handle,
      }),
    )

    // verify → scope-aware typecheck → tests → lint. Throws on any failure.
    await ctx.step('verify', () =>
      verify({
        taskId: input.taskId,
        kind,
        integrationBranch,
        recoveryPayload: input.recoveryPayload ?? null,
        worktree,
        store,
        trace,
      }),
    )

    // merge → serialized fast-forward into the integration branch (Vega on conflict).
    return await ctx.step('merge', () =>
      merge({
        taskId: input.taskId,
        kind,
        integrationBranch,
        worktree,
        store,
        trace,
        emit: (event) => ctx.emit('vcs-supervisor-event', event),
      }),
    )
  },
}
