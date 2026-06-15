# One library, three logical layers, scaffolded plain-JS workflows; supersedes ADR-0047

## Status

Proposed (DDD restructure strategy). **Supersedes ADR-0047.**

> **Amended 2026-06-15 — realized API shape.** Two authoring-surface
> details below were corrected to match what was built. The scaffolded
> file shape is `export default defineWorkflow({ id, fn })` (an imperative
> `async fn(ctx)` whose body calls `ctx.step(name, …)`), **not**
> `{ id, kind, steps }` — there is no declarative `steps` config. Dispatch
> facts arrive on `ctx.input`. The no-stranded-entity write funnel is the
> injected **`ctx.services.store`** (the Arc-backed task store), **not**
> `ctx.arc` — `ctx.arc` was never built. The architectural decision (one
> library, three layers, scaffolded plain-JS workflows composing engine
> step primitives) is unchanged; only these two names are corrected. See
> `orchestrator/docs/implement-pipeline.md` and
> `orchestrator/src/init/templates/workflows/workflow-contract.md` for the
> authoritative current surface.

## Context

ADR-0047 planned Mars as a *layered npm framework* extracted bottom-up into an
eight-rung package ladder (`@mars/workflow`, `@mars/claude-session`,
`@mars/agent-runtime`, `@mars/git-worktree`, `@mars/task-store`, `@mars/events`,
`@mars/agents`, `@mars/platform`, `@mars/workflows-official`). In practice that
decomposition is **too fine-grained** for the project's needs: eight publishable
packages with their own build/version surfaces is more ceremony than value when
there is a single consumer model. The genuinely valuable seams are far fewer.

The framework still needs two things ADR-0047 was reaching for: (a) clean
internal boundaries so the codebase stays AI-navigable and invariant-safe, and
(b) a way for consumers to author their own workflows.

## Decision

**One library: `@mars/mars`.** No internal package ladder. Inside the one lib,
**three logical layers** with strict, arch-test-enforced dependency direction:

1. **Engine** — workflow runtime (`defineWorkflow`, `ctx.step`), agent runtime
   (`runClaudeCode`), claude-session (PTY), git-worktree (worktree/verify/merge).
   Knows nothing of tasks/arcs. Exports **step primitives**
   (`setupWorktree, runAgent, verify, merge`) for scaffolded workflows.
2. **Domain** — aggregates (Arc, Tree, Proposal, Action Queue, Alert),
   invariants, stores, events, application services. **Process/HTTP/TTY-free.**
3. **Adapters** — daemon, CLI, UI, TUI, skills. Thin; call application services.

Dependency rule (build-guard): `adapters → domain → engine`, downward only;
domain imports no process/HTTP/TTY. The layers are folders, not packages; a
future physical split (if ever needed) is mechanical because the boundaries are
already proven.

**Workflows are not a package — they are scaffolded into the consumer repo.**
`mars init` writes the official workflows as plain-JS files into
`.mars/workflows/*.js`. Each file imports `defineWorkflow` + the step primitives
from the installed `mars` lib (the single `mars/workflow` surface) and
`export default defineWorkflow({ id, fn })`, where `fn` is an imperative
`async fn(ctx)` whose body wraps each durable unit in `ctx.step(name, …)` and
reads dispatch facts off `ctx.input`. The daemon
**dynamically imports** `.mars/workflows/*.js` at boot and on `mars daemon
reload`, registering each into the workflow registry. This is the realisation of
"the project is a framework allowing other people to implement their own workflow
on the `.mars` folder, configurable on plain JS — the workflows we ship are just
one implementation."

Custom workflows are **sandboxed**: they compose engine step primitives and may
write task state **only** through the injected Arc-backed store on
`ctx.services.store` — which the primitives use internally — never a raw client.
The no-stranded-entity invariant (ADR-0052) therefore holds for custom flows too.

## Consequences

- ADR-0047's eight-rung ladder is **retired**; the npm "package ladder" framing
  no longer applies. CLAUDE.md / AGENTS.md references to the ladder must be
  updated.
- `mars init` scaffolds workflows; `mars workflow scaffold/list/validate/reload`
  manage them. `mars workflow validate` contract-checks user files (including
  "raw store not imported") before the daemon loads them.
- Scaffolded workflows are **user-owned Hybrid files** (glossary). `mars update`
  never overwrites them — it shows a diff against the new template to merge
  (see ADR-0057). This intentionally differs from ADR-0004's
  "update overwrites manifest-listed files unconditionally": workflow files are
  not manifest-owned framework files, they are consumer code.
- The build-guard arch-test and the `strict` tsconfig discipline (no `any` in
  domain/engine; raw client unexported) are the mechanical enforcement of the
  layering.
