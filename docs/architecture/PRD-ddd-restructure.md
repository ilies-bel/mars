# PRD — Domain-Driven Restructure of Mars

> Status: **draft strategy** (awaiting approval). Implementation follows via a
> multi-agent Claude workflow once this and the ADRs are accepted.
> Companions: `bounded-contexts.html`, `aggregate-catalog.md`, ADRs 0052–0058.

## Problem

Mars has a deep but **implicit** domain model. Its invariants — every action
belongs to an arc, recovery tasks are leaves, the action queue is a pure
projection — are documented across 50+ ADRs and a rich glossary, but enforced
**per-function**, scattered across a 2,400-line `queue.ts`, two store facades,
several daemon subscribers, and the action-queue raise path. The consequence is
**stranded entities**: work that exists in the DB without a reachable arc.

The triggering symptom: `MARS-21175626`, a context-exhausted follow-up, renders
as *"No origin recorded"* because it was written with `origin_id = self` (its
parent reference lived only in prompt prose). The arc-inheritance fix (ADR-0050)
repairs this **forward**, but nothing in the model makes stranding *impossible*.

The deeper problem is the **absence of bounded contexts and aggregate roots**:
because there is no single owner of task/arc writes, every new mutation is one
more place an invariant can leak.

## Goals

1. **No stranded entity — by construction.** Every Action is attached to an Arc;
   every Arc has an origin Action. Enforced by an app-level **Arc aggregate
   root** that is the sole writer, with `assertArcInvariant()` on every path.
2. **A clear bounded-context decomposition** (capability view + one-lib layer
   view) with enforced dependency direction.
3. **One Action abstraction**, `kind`-routed to a workflow (`task`/`fix`/
   `diagnose`/`write`).
4. **Tree = Proposal + its Arcs**; standalone task = 1-Arc Tree.
5. **Alert as an arc-rooted aggregate**: goal → plain-English reason →
   technical drill-down; clears only by mutating the entity (no dismiss).
6. **One display seam**: CLI, daemon, TUI, skills are thin adapters over one
   application-service layer; zero re-implemented projection logic.
7. **User-extensible workflows**: sandboxed plain-JS in `.mars/workflows/*.js`,
   runtime-loaded, DB access only via injected arc services; user-owned files.
8. **One library** (`@mars/mars`), three logical layers (engine → domain →
   adapters), arch-test enforced. **ADR-0047's 8-rung ladder is retired.**
9. **One-command install** with a wizard (TTY) and full non-interactive mode
   (AI), every prompt mirrored by a flag/config key.
10. **JS that resists bad code**: `strict` tsconfig, no `any` in domain/engine,
    raw client unexported, arch-test build-guards.

## Non-goals

- **No historical backfill** of existing orphans. `MARS-21175626` and pre-fix
  follow-ups stay as-is; the invariant is enforced **forward only**.
- No physical npm package split in this iteration (one lib).
- No new persistence engine; `.mars/mars.db` stays the consolidated store.

## Bounded contexts (capability view)

Planning · Execution · Recovery · Operator Attention · Observability ·
Provisioning, over a Shared Kernel (ids, events/outbox, failure-kind, status).
See `bounded-contexts.html` tab 3 and the context map there.

## Layering (one lib, 3 logical layers)

- **Engine** — workflow runtime, agent runtime (`runClaudeCode`),
  claude-session, git-worktree; exports step primitives for scaffolded
  workflows. Knows nothing of tasks/arcs.
- **Domain** — aggregates (Arc, Tree, Proposal, Action Queue, Alert),
  invariants, stores, events, **application services**. Process/HTTP/TTY-free.
- **Adapters** — daemon, CLI, UI, TUI, skills. Thin; call application services.

Arch-test build-guard: imports point downward only; no `INSERT INTO tasks`
outside the Arc aggregate; no projection logic outside the domain layer.

## User stories

1. *As the operator*, when a task fails, I see **one Alert per failed arc** that
   leads with the original goal, then a plain-English reason, then technical
   detail — never a wall of traces first, never duplicate rows per recovery.
2. *As the operator*, I **cannot dismiss an Alert**; it disappears only when I
   fix, restart, or purge the underlying arc.
3. *As a framework consumer*, I run **one command** to install Mars: a wizard if
   I'm at a terminal, fully scripted (`--yes` / `-f config.json`) if I'm an AI
   or in CI.
4. *As a framework consumer*, I **write my own workflow** in plain JS in
   `.mars/workflows/`, composing provided step primitives; my custom flow
   **cannot create a stranded task** because DB writes go through injected arc
   services only.
5. *As a framework consumer*, `mars update` **never clobbers** my edited
   workflow files — it shows a diff to merge.
6. *As any display (UI/TUI/skill/CLI)*, I call the **same application services**;
   the projection and invariant logic exists in exactly one place.
7. *As a maintainer*, the build **fails** if anyone adds a raw task insert, an
   upward layer import, or an `any` in the domain/engine.

## Acceptance criteria

- [ ] Creating a task by any path (CLI, daemon RPC, scaffolded workflow) yields
      an Action with a resolved `origin_id` pointing at a real Action; an
      attempt to write a stranded entity throws `assertArcInvariant`.
- [ ] All task/arc INSERTs route through the Arc aggregate; arch-test fails on
      any other `INSERT INTO tasks`.
- [ ] `mars alert show <id>` returns `goal`, `reason`, `technical{...}` for a
      failed arc; one alert per arc (ADR-0051 preserved).
- [ ] No dismiss/ack/resolve verb or `/view/todo/dismiss` endpoint remains
      (ADR-0048 fully realized).
- [ ] `mars init` runs a wizard on a TTY and completes non-interactively with
      `--yes`; a parity test asserts every wizard prompt has a flag/config key.
- [ ] A user workflow in `.mars/workflows/*.js` is runtime-loaded by the daemon,
      handles its `kind`, and cannot import the raw store (validated by
      `mars workflow validate`).
- [ ] `mars update` shows a diff and does not overwrite an edited scaffolded
      workflow.
- [ ] One application-service module; UI/TUI/CLI/skills are adapters; arch-test
      forbids projection logic outside the domain.
- [ ] tsconfig `strict` + `noUncheckedIndexedAccess` +
      `exactOptionalPropertyTypes`; no `any` in domain/engine; build green.
- [ ] Existing test suite green; behavior parity verified after the refactor
      (the implementation workflow includes an adversarial verify pass).

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Funneling every writer through one aggregate is a wide blast radius | Slice by context; keep `updateTask` as the transition primitive *inside* the aggregate; behavior-parity verify per slice |
| Runtime-loading user JS is an execution-trust surface | Sandboxed step primitives; no raw store in scope; `mars workflow validate` gate before load |
| Arch-tests may flag legitimate existing imports during transition | Land the guard last, after the moves; allowlist with explicit TODO burndown |
| "One lib" conflicts with ADR-0047 readers | New ADR explicitly supersedes 0047; update CLAUDE.md/AGENTS.md references |

## Rollout

1. **Approve** this PRD + ADRs 0052–0058 (this step).
2. **Implement** via a multi-agent Claude workflow: slice by bounded context,
   isolate file-mutating agents in worktrees, adversarially verify each slice
   against the acceptance criteria, then a behavior-parity pass.
3. **Update** glossary (Tree, Action, Alert) and CLAUDE.md/AGENTS.md.
