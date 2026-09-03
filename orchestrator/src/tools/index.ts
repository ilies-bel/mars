/**
 * The Mars tool surface — the leaves split out of the former 4,622-line
 * `workflows/primitives/index.ts` god module (docs/rework/TARGET-ARCHITECTURE.md
 * §2.1), grouped by capability rather than by layer noun.
 *
 * ```
 * tools/
 * ├── context.ts            MarsServices / MarsCtx + the per-ctx memoised caches
 * ├── validate-recorder.ts  the `mars workflow validate` dry-run seam
 * ├── coder/                session-key, worktree-currency, setup-worktree, run-agent
 * ├── verify/               selection, review (the verify gate shell)
 * ├── merge/                merge (delegates to the durable merge worker)
 * ├── human/                await-human (the manual / live-step park)
 * ├── report/               finalize-report
 * └── qa/                   finalize-mockup
 * ```
 *
 * CRITICAL — no-stranded-entity invariant (ADR-0052). Each of these primitives
 * is a *framework-owned shell*: it may delegate the domain-agnostic work (pick a
 * worker, run the gates, enqueue the merge job), but the task-state write always
 * happens inside the shell, through `ctx.services.store` (the Arc aggregate).
 * A user-owned `.mars/workflows/*.js` composing these primitives therefore
 * cannot strand a task, and a swapped tool cannot skip the write.
 *
 * `workflows/authoring.ts` (the frozen `mars/workflow` barrel) and
 * `workflows/primitives/index.ts` both re-export from here; neither may narrow
 * this surface.
 *
 * STILL OWED (Phase D steps 2-3 of docs/rework/MIGRATION.md, deliberately not
 * folded into the index.ts split):
 *
 *  - `workflows/primitives/shared.ts` has not moved yet, so several modules
 *    here import UPWARD into `workflows/`. That is not a cycle and breaks no
 *    rule that is switched on today, but it is backwards: the direction is
 *    workflows -> tools. Its target is a three-way split into
 *    `tools/shared/{prompt,abort-messages,post-coder-state}.ts`, and
 *    `workflows/context-gathering-brief.ts` has to travel with it.
 *  - The QA leaves (`primitives/{behaviour-verify,browser-check,
 *    app-boot-discovery}.ts`) and `primitives/opts-descriptors.ts` still live
 *    under `workflows/`; their homes are `tools/qa/` and `tools/`.
 *  - `verify/review.ts` is still ~1,150 LOC — it is one primitive with three
 *    review types and that internal shape is unchanged. What *did* move (the
 *    Phase-F `VerifyTool` extraction): the primitive now sits behind the
 *    Verifier Port as the `review` kind (`../core/ports/verifier/
 *    review-verifier.ts`, registered next to the gate-execution-level
 *    `local` kind), and this barrel re-exports that Port-resolved wrapper
 *    under the `review` name rather than importing `verify/review.ts`
 *    directly. A further line-count split of `verify/review.ts` itself is
 *    still owed.
 */

export { buildSessionKey } from './coder/session-key'

export type {
  MarsServices,
  MarsWorkflowInput,
  MarsCtx,
  PrimitiveTraceArgs,
} from './context'
export {
  resolveTrace,
  resolveWorktree,
  readWorkflowInput,
  resolveTaskId,
  spanStore,
  buildPhaseCtx,
  buildTraceIdentity,
  cacheWorktree,
  cacheIndexCard,
  readCachedIndexCard,
} from './context'

export type { ValidateRecorderEntry, ValidateRecorder } from './validate-recorder'
export { validationRecorder } from './validate-recorder'

export { ensureWorktreeCurrent } from './coder/worktree-currency'
export type { SetupWorktreeOpts, SetupWorktreeResult } from './coder/setup-worktree'
export { setupWorktree } from './coder/setup-worktree'
export type { RunAgentOpts, RunAgentResult } from './coder/run-agent'
export { runAgent } from './coder/run-agent'

export { buildSpecVerifyCmdStep } from './verify/selection'
// `review` is resolved through the Verifier Port registry (ADR-0097) rather
// than imported from `./verify/review` directly — see
// `../core/ports/verifier/review-verifier.ts`. `runReview` is re-exported
// under the `review` name so every existing `review(ctx, opts)` call site
// (the bundled pipelines, scaffolded `.mars/workflows/*.js` templates) keeps
// working unchanged.
export type { ReviewOpts, VerifyGateOutcome, ReviewResult } from '../core/ports/verifier/review-verifier'
export { runReview as review } from '../core/ports/verifier/review-verifier'

export type { MergeOpts, MergeOutput } from './merge/merge'
export { merge } from './merge/merge'

export type { AwaitHumanOpts } from './human/await-human'
export { awaitHuman } from './human/await-human'

export type { FinalizeReportOpts } from './report/finalize-report'
export { finalizeReport } from './report/finalize-report'

export type { FinalizeMockupOpts } from './qa/finalize-mockup'
export { finalizeMockup } from './qa/finalize-mockup'
