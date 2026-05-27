# Migration: Mastra → `@mars/workflow` (as built)

**Status:** done. The orchestrator no longer depends on `@mastra/*`.

This records what actually happened. An earlier draft of this file
proposed a phased, flag-gated coexistence (an `MARS_WORKFLOW_ENGINE`
env var, a per-workflow allowlist, golden tests, shadow-runs, canary by
task kind, and a one-release `mastra.db` grace window). **None of that
was done.** Per the project's "every change is a hard cut" rule, the
migration was a straight cut, one pipeline at a time, with the
orchestrator kept green at every commit — but with no flag, no
coexistence, and no rollback window. The old plan is preserved only in
git history.

## What `@mars/workflow` is

A small, imperative, checkpoint-resume workflow engine living in
`packages/workflow/`. A workflow is a plain async function whose native
control flow (`if`/`for`) is the source of truth; `ctx.step(name, fn)`
wraps each durable unit. Durability is checkpoint-resume keyed on
`runId`, not deterministic replay. See `orchestrator/docs/implement-pipeline.md`
for the canonical pattern.

This supersedes the authoring model of **ADR 0012** (declarative DAG of
`defineStep({deps})`) and **ADR 0014** (linear `.then` composition).

## What was migrated, in order

| Pipeline | Outcome |
|---|---|
| engine + `implement` | built first; flagship ported (prior session) |
| `ab-experiment` | **deleted, not ported** — a hard cut, removing one consumer |
| `triage` + `plan` | ported (single `ctx.step` each) |
| `slice` | ported (single `ctx.step`; the 900 LOC is helpers, not topology) |
| `init` | ported (five linear `ctx.step`s; disk + DB side effects preserved) |
| `@mastra/*` removal | `src/mastra/index.ts` (the `Mastra` instance) deleted; the five `@mastra/*` packages + the `mastra` CLI dropped from `package.json` |

Each pipeline's dispatch was switched from `workflow.createRun().start()`
(or `mastra.getWorkflow(id)`) to `runWorkflow(wf, input, { store:
createQueueWorkflowStore(), services, ... })`. The Mastra
`requestContext.get('taskStore')` seam became `ctx.services.store`;
`tracingContext` was dropped; `writer.write(...)` became `ctx.emit(...)`.
Failures THROW — the engine records the step failed and `runWorkflow`
returns `{ status: 'failed', error }`.

The workflow files also moved out of the `mastra/` namespace:
`src/mastra/workflows/` → `src/workflows/`.

## What survived (intentionally)

- `src/mastra/context.ts` — `mastraDbPath` / `observabilityDbPath` are
  still resolved; the DuckDB observability path is used by
  `lib/observability-spans.ts` and the daemon, independent of Mastra.
- `src/init/detect-stack.ts` — the `'@mastra/core'` string in the
  tech-detection list is data (it detects whether a *target* repo uses
  Mastra), not a dependency.
- `.mars/mastra.db` on disk — not read by any code path; left as dust.

## Verification

Hard cut, so the bar at the merge was simply: `tsc --noEmit` clean and
the full `vitest run` green on a tree carrying `main`'s real dependency
graph (single deduped `zod`), branched off current `main`. No golden
tests, no shadow-runs, no engine-stats subcommand — those belonged to
the abandoned coexistence plan.
