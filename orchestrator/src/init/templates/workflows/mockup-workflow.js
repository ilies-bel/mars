/**
 * mockup-workflow — cheap visual mockup before implementation.
 *
 * This is a READ-ONLY pipeline: it generates a self-contained HTML mockup
 * for a proposal, saves it to `.mars/mockups/<proposalId>.html`, and raises
 * a `mockup-ready` notice. No code is merged into the integration branch.
 *
 * Trigger:  mars proposal mockup <id>
 * Output:   .mars/mockups/<proposalId>.html  (self-contained HTML wireframe)
 * Notice:   mockup-ready  (action-queue row, dismissable)
 *
 * The agent must write a single file `mockup.html` at the worktree root.
 * The file must be self-contained: no external URLs, inline all CSS/JS.
 */
import { defineWorkflow, setupWorktree, runAgent, finalizeMockup } from 'mars/workflow'

export default defineWorkflow({
  id: 'mockup',
  async fn(ctx) {
    await ctx.step('setup', () => setupWorktree(ctx))
    await ctx.step('code', () => runAgent(ctx))
    return await ctx.step('finalize', () => finalizeMockup(ctx))
  },
})
