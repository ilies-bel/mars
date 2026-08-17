# Modular core — target and status

> Folded in from `docs/rework/{TARGET-ARCHITECTURE,MIGRATION}.md`, condensed.
> For the current on-disk module map, see [`ARCHITECTURE.md`](../../ARCHITECTURE.md#in-flight-vs-target)
> — this document is the plan and the log, not the ground truth.
>
> Branch: `rework/modular-core`. Companions: ADR-0052 (Arc is the sole
> writer), ADR-0056 (one library, three logical layers — amended by this
> rework, see "Non-goals" below), ADR-0057 (scaffolded workflows are
> user-owned), ADR-0093 (steward findings always enqueue).

## The one-paragraph version

Mars is becoming a small meta-framework: a **container** (service registry +
plugin lifecycle + typed event bus — cordis itself, since 4.0.1 was adopted)
that a set of
**tools** (coder, verify, merge, qa, deploy) register into, instead of being
hard-imported from a god module; and a set of **registries** that turn closed
unions (`ProviderName`, `WorkerName`, the verify-primitive union) into open,
seedable sets. Every default ships wired — one install, no external modules,
zero configuration to get today's behaviour. Swapping a tool, a provider, or
a verify heuristic is opt-in configuration, never a fork.

One thing does **not** become pluggable: the Arc write funnel (ADR-0052). A
tool never writes task state; the framework-owned primitive shell that
invoked it does, through `ctx.services.store`. Plugins swap what a tool does,
never whether task state is recorded. `store` and `traceStore` are sealed
services — `ctx.provide('store', …)` throws at registration time. They are
installed as cordis ACCESSORS rather than services, which is what makes the
seal hold under `ctx.isolate('store', …)` as well: a `provide`-based seal only
rejects duplicates inside one isolation scope.

## Status by phase

| Phase | Goal | Status |
| --- | --- | --- |
| A — neutral agent contracts | `AgentEvent`/`AgentInvocationResult` replace `ClaudeEvent`/`RunClaudeResult` in neutral seams | Partial — neutral types added, Claude-named originals still present and still used in `core/lib/claude-stream.ts` / `core/lib/git/claude.ts`. Not a hard cut yet. |
| B — the container | Service registry + plugin host + event bus | Done. Landed at `packages/workflow/src/container/`, not `orchestrator/src/container/` as originally specified — then replaced outright by **cordis 4.0.1** at `packages/workflow/src/ctx/`. `WorkflowCtx.container` is a real `Context`; the 688 LOC of hand-rolled container are gone. Mars still owns four things cordis does not provide: the ADR-0052 seal, a fiber-free keyed registry, fault-isolated `emit`, and a runtime mirror of the `FiberState` const enum (which cordis erases at build time). |
| C — open registries | Replace `ProviderName`/`WorkerName`/primitive unions with registries | Done for providers and workers (`core/workers/{provider,worker}-registry.ts`), aliased so old `Record<ProviderName, …>` call sites keep compiling. Primitive registry not yet extracted from `core/lib/primitive-catalog.ts`. |
| D — split `primitives/index.ts` | 4,622-LOC god module → `tools/` capability folders | Mostly done — `tools/{coder,verify,merge,human,report,qa}/` exist. `workflows/primitives/shared.ts` (prompt composition, abort messages) and the QA leaves (`behaviour-verify.ts`, `browser-check.ts`, `app-boot-discovery.ts`) still live under `workflows/primitives/`; `tools/index.ts` documents this as "still owed." |
| E — verify heuristics out of the runner | No tool-specific knowledge in the verify runner | Done — `registries/verify-heuristics.ts` + `tools/verify/heuristics/{typescript-toolchain,infra-failure-patterns}.ts`, dispatched via `serial`. |
| F — tools resolved through `ctx.tools` | Primitive shells resolve implementations from the container instead of importing them | Not started. Tools are still directly imported by the shells that use them. |
| G — `growth/` | Reflect, narration, step-suggestion under one folder | Partial — `growth/heuristics.ts` and `growth/step-suggestions.ts` exist and file draft proposals. `narration/` and the reflect pipeline (`core/lib/reflector.ts` and friends) have not moved under `growth/` yet. |
| H — arch rules + arch tests | Dependency-cruiser rules + vitest arch tests enforcing the boundaries above | Partial — four dependency-cruiser boundary rules plus the ADR-0052 source guards (`no-any-domain-engine.test.ts`, `sealed-write-funnel-guard.test.ts`). The sealed-service guard is deliberately NOT a dependency-cruiser rule: it reasons about imports, never call expressions, and `includeOnly` keeps npm packages out of the graph. |
| I — `core/daemon` → `daemon` path move | Pure rename, optional | Not started; low priority. |

## Non-negotiable invariants

1. **The Arc funnel is non-bypassable (ADR-0052).** Every primitive that
   mutates task state routes the mutation through `ctx.services.store`. A
   tool returns a result; the framework-owned shell writes.
2. **`mars/workflow` stays backward compatible.** `orchestrator/package.json`
   maps `"./workflow"` to `src/workflows/authoring.ts`. Every symbol that
   barrel exports today (`defineWorkflow`, `WorkflowCtx`, `setupWorktree`,
   `runAgent`, `review`, `merge`, `awaitHuman`, `finalizeReport`,
   `finalizeMockup`, `behaviourVerify`, and their option types) must keep
   working — the barrel's body may be re-pointed, its surface may only grow.
3. **Step names are durable keys.** `ctx.step(name, …)` names are read back
   by checkpoint-resume. Renaming one is a data migration (an alias table),
   not a find-and-replace.
4. **The arch baseline may only shrink.** `.dependency-cruiser-known-
   violations.json` is keyed by file path. Moving a file that participates
   in a baselined cycle re-keys its violation and looks like a new one.
   Regenerating the baseline to hide that is forbidden — the cycle gets
   broken instead. The only legitimate regeneration is switching on Phase H's
   brand-new rules, once, called out explicitly in that commit.

## Non-goals

- No literal `engine/ domain/ adapters/` three-folder tree — ADR-0056's
  *direction* is enforced by dependency-cruiser rules against the capability
  folders that actually exist (`tools/`, `registries/`, `container/`,
  `growth/`, …); its literal folders are superseded.
- No package split — one library, `mars`, one `exports` map (`.` and
  `./workflow`).
- No plugin marketplace, no `node_modules` plugin discovery, no plugin
  manifest format. The only extension points are the built-in seeds and
  whatever a `.mars/workflows/*.js` file registers through the frozen
  barrel.
- No rewrite of `core/`. This rework moves leaves and inverts dependencies;
  it does not re-architect the domain.
- No behaviour change. Every phase is verified by the existing test suite
  passing unchanged.

## Verify commands for any phase

```bash
pnpm --filter mars run typecheck      # tsc --noEmit over orchestrator
pnpm --filter mars test               # vitest run  (ADR-0033)
npm run arch                          # dependency-cruiser, root + ui
```
