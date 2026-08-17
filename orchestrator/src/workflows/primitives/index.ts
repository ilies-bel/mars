/**
 * Git step-primitive surface (ADR-0056) — now a thin re-export barrel.
 *
 * ADR-0056 frames the orchestrator as "one library, three logical layers" and
 * says scaffolded `.mars/workflows/*.js` files should COMPOSE engine
 * step-primitives — "workflows are just one implementation". This module is
 * that composable surface: the reusable primitives — `setupWorktree`,
 * `runAgent`, `review`, `merge`, `awaitHuman`, `finalizeReport`,
 * `finalizeMockup` — mirroring the steps of the bundled implement pipeline.
 *
 * The `@mars/workflow` engine is deliberately domain-agnostic (it knows nothing
 * about git or Arc). So the primitive surface lives HERE, in the orchestrator
 * (the domain library), and is imported by BOTH:
 *   - the bundled `implement-workflow.ts` (its step bodies are thin
 *     compositions over these primitives), and
 *   - scaffolded `.mars/workflows/<kind>-workflow.js` files (which import the
 *     primitives and call them with what `ctx` / `ctx.services` provides).
 *
 * Each primitive takes `(ctx, opts)` — the engine `WorkflowCtx` plus a small
 * bag of per-call domain options. ALL plumbing (the Arc `store`, the trace
 * store, the live step handle, the `emit` sink, the resolved worktree ref) is
 * pulled from `ctx` / `ctx.services` internally, so a scaffolded `.mars/
 * workflows/*.js` file calls them as `setupWorktree(ctx, { kind })` and never
 * touches the plumbing. This is the "options bag with defaults" ergonomics
 * (ADR-0056).
 *
 * WHERE THE CODE LIVES. The implementations moved to `orchestrator/src/tools/`,
 * grouped by capability (docs/rework/TARGET-ARCHITECTURE.md §2.1) — this file
 * used to hold all 4,622 lines of them. It is kept as a barrel because its
 * import specifier is a published contract: `workflows/authoring.ts` (the
 * `mars/workflow` entry point) and user-owned `.mars/workflows/*.js` files in
 * consumer repos resolve through it. Its surface may grow, never shrink.
 * Add new code under `tools/`, not here.
 *
 * CRITICAL — no-stranded-entity invariant (ADR-0052). Every primitive that
 * mutates task state routes that mutation through `ctx.services.store`
 * (the Arc-backed `DomainTaskStore`) and the failure handler's `store` arg.
 * A custom workflow that calls these primitives therefore CANNOT bypass Arc —
 * the write funnel is baked into the framework-owned primitive shell, not left
 * to the caller, and a swapped tool never sees `store`.
 */

export * from '../../tools'
