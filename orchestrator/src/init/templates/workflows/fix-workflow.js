// @mars-workflow-template:v1
//
// fix-workflow.js — the recovery pipeline for a failed task.
//
// SCAFFOLDED by `mars init` into `.mars/workflows/` and USER-OWNED (ADR-0057):
// edit freely. `mars update` shows a diff instead of overwriting your edits.
//
// Recovery tasks are leaf nodes (ADR-0040): exactly one recovery attempt per
// origin failure, no blockers, no retry budget.
//
// Like the task pipeline, a fix COMPOSES the exported git step-primitives
// (ADR-0056) from `mars/workflow-primitives`. With `kind: 'fix'` the primitives
// do the recovery-specific thing automatically: `setupWorktree` ATTACHES to the
// origin's worktree+branch (via `fixForTaskId`) and stacks the fix commit there
// rather than carving a fresh worktree, and `runAgent` routes to the Fixer
// (Opus, recovery resilience). Every task-state write still funnels through the
// injected Arc store (`ctx.services.store`, ADR-0052).

/** @typedef {import('@mars/workflow').WorkflowCtx} WorkflowCtx */

import {
  buildPrimitiveTrace,
  setupWorktree,
  runAgent,
  verify,
  merge,
} from 'mars/workflow-primitives'

export default {
  id: 'fix',
  /**
   * @param {WorkflowCtx} ctx
   * @param {{
   *   taskId: string,
   *   prompt: string,
   *   plan?: unknown,
   *   tags?: string[],
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
    // Recovery: kind is always 'fix' for this pipeline.
    const kind = 'fix'
    const trace = await buildPrimitiveTrace(ctx.runId, input.taskId)

    // setup → attach to the origin worktree (fixForTaskId) and install deps.
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

    // fix-code → the Fixer (Opus) attempts the repair on the origin's branch.
    await ctx.step('fix-code', (handle) =>
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
