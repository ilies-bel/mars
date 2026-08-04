// @mars-workflow-template:v3
//
// write-workflow.js — the structured-write pipeline (glossary / ADR / docs).
//
// SCAFFOLDED by `mars init` into `.mars/workflows/` and USER-OWNED (ADR-0057):
// edit freely. `mars update` shows a diff instead of overwriting your edits.
//
// Structured writes are deterministic, no-LLM edits to CONTEXT.md / docs/knowledge/decisions/**
// merged back through the serialized merge lock. The steps below are
// hand-written placeholders for you to flesh out. Dispatch facts come off
// `ctx.input` (e.g. `ctx.input.target`), just like the primitive-based flows.

/** @typedef {import('mars/workflow').WorkflowCtx} WorkflowCtx */

import { defineWorkflow } from 'mars/workflow'

export default defineWorkflow({
  id: 'write',
  /** @param {WorkflowCtx} ctx */
  async fn(ctx) {
    const { target, payload } = ctx.input

    await ctx.step('setup', async () => {
      // Fresh worktree off the integration branch.
      return { target }
    })

    await ctx.step('apply-write', async () => {
      // Deterministic edit of the target file (glossary term, ADR, etc).
      return { payload }
    })

    await ctx.step('merge', async () => {
      // Commit + fast-forward into the integration branch via the merge lock.
      return { merged: true }
    })

    return { target, status: 'done' }
  },
})
