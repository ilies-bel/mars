# Architecture

> Snapshot of what exists today, on `rework/modular-core`. Honest about what's
> still in flight. When in doubt, the code under `orchestrator/src/` and
> `packages/` is the source of truth — this file is a map, not a spec.

## How to traverse this repo

Start from the question you have, not the top of the tree:

1. **"What does `mars` do when I run it?"** → `orchestrator/src/cli.ts` is the
   single entry point; subcommands live in `orchestrator/src/commands/`.
2. **"What happens to a queued task?"** → `orchestrator/src/core/daemon/`
   (the watcher/dispatcher) calls into `orchestrator/src/workflows/` (the
   bundled pipelines: implement, plan, init, slice, triage, validate).
3. **"What does a workflow step actually do?"** → workflows call into
   `orchestrator/src/tools/`, grouped by capability (`coder/`, `verify/`,
   `merge/`, `human/`, `report/`, `qa/`). Each tool is a *shell*: it delegates
   the real work and always funnels the resulting task-state write through
   the Arc store (`ctx.services.store`) — this is the one invariant nothing
   in this rework is allowed to break (ADR-0052).
4. **"How do I add a new provider/worker/verify check without forking?"** →
   the open registries: `orchestrator/src/registries/verify-heuristics.ts`,
   `orchestrator/src/core/workers/provider-registry.ts`,
   `orchestrator/src/core/workers/worker-registry.ts`. These replaced closed
   unions (`ProviderName`, `WorkerName`) with seedable, `register()`-able sets.
5. **"What's the actual plumbing — services, plugins, events?"** →
   `packages/workflow/src/ctx/` — the service container. It IS
   [cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) (`Context`,
   `Fiber`, `ctx.plugin`, `ctx.effect`, the event bus) plus four Mars-owned
   pieces cordis does not provide. This is what makes tools swappable from a
   `.mars/workflows/*.js` file without touching this repo.
6. **"How does Mars improve itself over time?"** →
   `orchestrator/src/growth/` (step-gap heuristics that turn recurring
   friction into draft proposals) and `orchestrator/src/narration/` (pure,
   deterministic "why did this arc need me" explanations — zero model calls).
7. **"Where's the UI?"** → `ui/` — a read-only Vite/React SPA over the daemon's
   HTTP API. It never mutates state; the CLI is the only write surface.

If you're editing rather than reading: change the tool/workflow, not the
container — the container is deliberately inert scaffolding (a leaf; it
imports nothing above it).

## Module map

| Concept | Directory | What it owns |
| --- | --- | --- |
| CLI entry point | `orchestrator/src/cli.ts`, `orchestrator/src/commands/` | Every `mars <subcommand>`. |
| Daemon | `orchestrator/src/core/daemon/` | Polls the task queue, dispatches workflows, serializes merges, exposes the HTTP API the UI reads. |
| Workflows (pipelines) | `orchestrator/src/workflows/` | The bundled state machines: implement, plan, init, slice, triage, validate, tool-forge. `authoring.ts` is the frozen `mars/workflow` barrel that user-owned `.mars/workflows/*.js` files import. |
| Tools | `orchestrator/src/tools/` | The domain-agnostic leaves a workflow step calls: `coder/` (setup-worktree, run-agent), `verify/` (review, selection), `merge/`, `human/` (await-human), `report/` (finalize-report), `qa/` (finalize-mockup, behaviour-verify — mid-move, see below). |
| Registries | `orchestrator/src/registries/`, `orchestrator/src/core/workers/{provider,worker}-registry.ts` | Open, seedable sets that replaced closed unions: providers, workers, verify heuristics. `register()` returns a disposer; nothing is a hard-imported god list anymore. |
| Container | `packages/workflow/src/ctx/` | The meta-framework, now cordis 4.0.1 itself (`Context` = services + plugin fibers + typed event bus + effect-based teardown) plus what cordis leaves to the host: `sealed.ts` (the ADR-0052 guard — `store`/`traceStore` are context ACCESSORS, so they cannot be provided, isolated, re-declared or assigned), `registry.ts` (a fiber-free keyed registry for module-level singletons), `safe-listen.ts` (fault-isolated dispatch — cordis's `emit` lets a throwing listener reach the emitter), `fiber-state.ts` (a runtime mirror of a const enum that is erased at build time), `run-container.ts` (composes one Context per run). |
| Domain / core | `orchestrator/src/core/` | Task queue, Arc aggregate, proposals, action queue, blocker resolution, reflect signals. Out of scope for this rework — it keeps its current internals. |
| Growth | `orchestrator/src/growth/` | Step-gap heuristics (`heuristics.ts`, `step-suggestions.ts`) that read task history and file draft proposals — never a direct edit to a user's workflow file. |
| Narration | `orchestrator/src/narration/` | Pure, deterministic arc-outcome explanations (`landed` / `stumbled-recovered` / `needs-you`). No clocks, no randomness, no model calls. |
| UI | `ui/` | Vite + React SPA, read-only Kanban over daemon state via SSE. |

## In-flight vs. target

This module map is where the code is *today*. The fuller target — an
`engine/` folder isolating the neutral agent contracts, `orchestrator/src/
container/` and `registries/` as first-class siblings of `tools/`, and a
`growth/reflect/` + `growth/narration/` regrouping — is written up in
[`docs/architecture/modular-core.md`](./docs/architecture/modular-core.md).
That document is the plan; this file is the ground truth. Notable gaps
between them right now:

- The service container lives in `packages/workflow/src/ctx/`, not
  `orchestrator/src/container/`. It works; it just wasn't moved.
- Neutral agent contracts (`AgentEvent`, `AgentInvocationResult`) exist
  alongside their Claude-named originals (`ClaudeEvent` in
  `core/lib/claude-stream.ts`, `RunAgentResult` in `core/lib/git/claude.ts`)
  rather than fully replacing them — both still compile and both are used.
- `orchestrator/src/registries/` holds only `verify-heuristics.ts`. Provider
  and worker registries live at `core/workers/{provider,worker}-registry.ts`
  instead of moving under `registries/`.
- `workflows/primitives/shared.ts` (prompt composition, abort messages) and
  the QA leaves (`behaviour-verify.ts`, `browser-check.ts`,
  `app-boot-discovery.ts`) still live under `workflows/primitives/`, not
  `tools/`. `orchestrator/src/tools/index.ts` documents this explicitly as
  "still owed."
- `narration/` and the reflect pipeline (`core/lib/reflector.ts` and
  friends) haven't moved under `growth/` yet; only the new step-suggestion
  heuristics have.

None of this is a regression — every gap above is deliberately sequenced work
tracked in `docs/architecture/modular-core.md`, not an accident.

## The one invariant

Every tool that touches task state writes through the Arc-backed store
(`ctx.services.store`, injected by the daemon), never around it. A plugin, a
custom `.mars/workflows/*.js` file, or a swapped verify/coder/merge tool can
change *what* runs and *how it's classified* — it can never change *whether
the task row gets recorded*. `store` and `traceStore` are sealed services:
`ctx.provide('store', …)` throws. This is ADR-0052, and it's the one thing in
this repo that pluggability was explicitly designed never to touch.

## Everything else, by pointer

- **Runtime state on disk** (per target repo): `<repo>/.mars/` — embedded
  Postgres (`pg/data/`), git worktrees (`worktrees/<task-id>/`), the merge
  lock, generated supervisors. Never committed.
- **Task schema, CLI surface, LLM call boundary**: see
  `orchestrator/AGENTS.md` and `orchestrator/README.md` — these change often
  enough that duplicating them here would just go stale.
- **Domain glossary**: `CONTEXT.md`. **Hard-to-reverse decisions**:
  `docs/knowledge/decisions/*.md` (ADRs). Both are edited only through
  `mars glossary` / `mars adr`, never by hand.
