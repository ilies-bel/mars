// @mars-workflow-template:v2
//
// write-workflow.js — the structured-write pipeline (glossary / ADR / docs).
//
// SCAFFOLDED by `mars init` into `.mars/workflows/` and USER-OWNED (ADR-0057):
// edit freely. `mars update` shows a diff instead of overwriting your edits.
//
// Structured writes are deterministic, no-LLM edits to CONTEXT.md / docs/adr/**
// merged back through the serialized merge lock. The steps below are
// hand-written placeholders for you to flesh out.

/** @typedef {import('mars/workflow').WorkflowCtx} WorkflowCtx */

import { defineWorkflow } from 'mars/workflow'

export default defineWorkflow({
  id: 'write',
  /**
   * @param {WorkflowCtx} ctx
   * @param {{ target: string, payload: unknown }} input
   */
  async fn(ctx, input) {
    await ctx.step('setup', async () => {
      // Fresh worktree off the integration branch.
      return { target: input.target }
    })

    await ctx.step('apply-write', async () => {
      // Deterministic edit of the target file (glossary term, ADR, etc).
      return { payload: input.payload }
    })

    await ctx.step('merge', async () => {
      // Commit + fast-forward into the integration branch via the merge lock.
      return { merged: true }
    })

    return { target: input.target, status: 'done' }
  },
})
