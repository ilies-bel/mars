/**
 * `mars/workflow` — the single import surface for authoring workflows.
 *
 * A scaffolded `.mars/workflows/<kind>-workflow.js` (ADR-0056) imports
 * EVERYTHING it needs from here:
 *
 * ```js
 * import { defineWorkflow, setupWorktree, runAgent, verify, merge } from 'mars/workflow'
 *
 * export default defineWorkflow({
 *   id: 'task',
 *   async fn(ctx, input) {
 *     const worktree = await ctx.step('setup', () => setupWorktree(ctx, { kind: input.kind }))
 *     await ctx.step('code',   () => runAgent(ctx, { prompt: input.prompt, tags: input.tags }))
 *     await ctx.step('verify', () => verify(ctx, { kind: input.kind }))
 *     return  ctx.step('merge',  () => merge(ctx, { kind: input.kind }))
 *   },
 * })
 * ```
 *
 * This barrel unifies the two underlying seams so the author never juggles
 * specifiers:
 *   - the domain-agnostic ENGINE (`@mars/workflow`): `defineWorkflow` + types,
 *   - the Mars DOMAIN PRIMITIVES (`./primitives`): `setupWorktree`, `runAgent`,
 *     `verify`, `merge`, each `(ctx, opts)` with all plumbing hidden.
 *
 * It deliberately does NOT import the bundled `implement-workflow.ts` — the
 * daemon loads that lazily as the fallback, and pulling it in here would drag
 * its heavy dependency graph into every user-file import.
 */

// ── Engine: workflow definition + the types an author references ──────────────
export { defineWorkflow } from '@mars/workflow'
export type {
  Workflow,
  WorkflowCtx,
  WorkflowFn,
  StepHandle,
  StepOptions,
  WorkflowEvent,
} from '@mars/workflow'

// ── Domain primitives: the four composable steps (`(ctx, opts)`) ──────────────
export {
  setupWorktree,
  runAgent,
  verify,
  merge,
} from './primitives'
export type {
  MarsServices,
  MarsCtx,
  SetupWorktreeOpts,
  SetupWorktreeResult,
  RunAgentOpts,
  RunAgentResult,
  VerifyOpts,
  VerifyResult,
  MergeOpts,
  MergeOutput,
} from './primitives'
