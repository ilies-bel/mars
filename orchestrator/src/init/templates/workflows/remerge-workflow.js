// @mars-workflow-template:v1
//
// remerge-workflow.js — re-verify and merge an existing branch without re-coding.
//
// This workflow is used by `mars remerge <id>` when a task's branch already
// carries a complete, good commit but the task failed at a later phase (e.g.
// merge) or was stranded by an infra/config issue.  It skips the code step
// entirely and re-enters the pipeline at verify → merge.
//
// The branch is NOT recreated — `setupWorktree` detects that `task/<id>`
// already exists and creates a fresh worktree directory on it without touching
// the commits.  `verify` then runs scope-aware checks on those existing
// commits, and `merge` fast-forwards them into the integration branch.
//
// If the branch is contaminated (its tip is already an ancestor of the
// integration branch despite appearing "ahead"), `verify` will reject it with
// a `verify:branch-contaminated` failure and spawn a fix task as usual.

/** @typedef {import('mars/workflow').WorkflowCtx} WorkflowCtx */

import { defineWorkflow, setupWorktree, review, merge } from 'mars/workflow'

export default defineWorkflow({
  id: 'remerge',
  /** @param {WorkflowCtx} ctx */
  async fn(ctx) {
    // setup — create a fresh worktree directory on the EXISTING branch.
    // createWorktree detects that task/<id> already exists and attaches to it
    // rather than creating a new branch, so no committed work is lost.
    //
    // CRITICAL: pass `onConflict: 'reconcile'` so that a diverged branch is
    // rebased via the vcs-supervisor instead of being silently recreated to
    // the integration tip. Without this, the default 'recreate' policy would
    // park the existing commits, reset the branch to integration tip, and the
    // subsequent isZeroCommitBranch check would short-circuit the merge with
    // `status='done'` — marking the task done while the commits were never
    // integrated (the root cause of the silent data-loss bug this option was
    // added to fix, mars-fe86ca8f).
    await ctx.step('setup', () => setupWorktree(ctx, { onConflict: 'reconcile' }))

    // verify — scope-aware typecheck → tests → lint on the existing commits.
    // Throws on any failure (including branch contamination), so reaching
    // merge always means verify passed.
    await ctx.step('verify', () => review(ctx))

    // merge — serialized fast-forward into the integration branch.
    return await ctx.step('merge', () => merge(ctx))
  },
})
