/**
 * `mars/workflow` — the single import surface for authoring workflows.
 *
 * A scaffolded `.mars/workflows/<kind>-workflow.js` (ADR-0056) imports
 * EVERYTHING it needs from here:
 *
 * ```js
 * import { defineWorkflow, setupWorktree, runAgent, review, merge } from 'mars/workflow'
 *
 * export default defineWorkflow({
 *   id: 'task',
 *   async fn(ctx) {
 *     // Every primitive defaults its options from ctx.input (the dispatch
 *     // facts), so a step is just `primitive(ctx)`. Pass an options bag only
 *     // to override a field (e.g. runAgent(ctx, { model: 'claude-opus-4-7' })).
 *     await ctx.step('setup',  () => setupWorktree(ctx))
 *     await ctx.step('code',   () => runAgent(ctx))
 *     await ctx.step('review', () => review(ctx, { reviewType: 'auto' }))
 *     return  ctx.step('merge',  () => merge(ctx))
 *   },
 * })
 * ```
 *
 * This barrel unifies the two underlying seams so the author never juggles
 * specifiers:
 *   - the domain-agnostic ENGINE (`@mars/workflow`): `defineWorkflow` + types,
 *   - the Mars DOMAIN PRIMITIVES (`./primitives`): `setupWorktree`, `runAgent`,
 *     `review`, `merge`, each `(ctx, opts)` with all plumbing hidden.
 *
 * It deliberately does NOT import the bundled `implement-workflow.ts` — the
 * daemon loads that lazily as the fallback, and pulling it in here would drag
 * its heavy dependency graph into every user-file import.
 */

// ── Engine: the workflow definition helper + the one ctx type an author types ─
// Kept deliberately small. `WorkflowCtx` is what a `@typedef` / TS signature
// references; `StepHandle`/`WorkflowEvent`/etc. are advanced and importable
// straight from `@mars/workflow` if ever needed.
export { defineWorkflow } from '@mars/workflow'
export type { WorkflowCtx } from '@mars/workflow'

// ── Domain primitives: the five composable steps (`(ctx, opts)`) ──────────────
// Each defaults every field from `ctx.input`, so the terse form is just
// `runAgent(ctx)`. The `*Opts` types are exported for authors who want to type
// an explicit override bag; plumbing types (MarsServices) and per-call result
// types stay internal to `./primitives`.
export {
  setupWorktree,
  runAgent,
  review,
  merge,
  awaitHuman,
  finalizeReport,
} from './primitives'
export { behaviourVerify } from './primitives/behaviour-verify'
export type {
  MarsWorkflowInput,
  SetupWorktreeOpts,
  RunAgentOpts,
  ReviewOpts,
  MergeOpts,
  AwaitHumanOpts,
  FinalizeReportOpts,
} from './primitives'
export type { BehaviourVerifyOpts } from './primitives/behaviour-verify'
