# Displays are thin adapters over one application-service layer; the daemon is fully separated from display

## Status

Proposed (DDD restructure strategy).

## Context

The three display surfaces read three different ways: the UI proxies the daemon
HTTP API (with fallback projection logic mirrored in `ui/server/db.ts`), the
Claude skills shell out to the `mars` CLI, and the CLI itself mixes direct store
reads with daemon-routed writes. Projection and enrichment logic
(`buildActionQueueView`, `buildOriginTree`, action-queue detail) is partly
duplicated between the daemon and the UI server. There is no single seam every
surface shares, and there is no TUI. The user's requirement: *"the daemon is
fully separated from the display; the displays are TUI, Claude's skills, UI —
and each of them should call the same functions."*

## Decision

Define a single **application-service layer** (the use-case layer over the
domain aggregates) in the domain layer. Every surface — daemon HTTP, CLI, a new
**TUI**, and the Claude skills — becomes a **thin adapter** over that layer. No
surface re-implements projection, enrichment, or invariant logic.

```
            Application Services (use-cases)
              ↑        ↑        ↑       ↑
             CLI    daemon     TUI    skills
                    HTTP
```

- The application services expose the verbs in `aggregate-catalog.md §9`
  (proposals, trees, arcs, actions, recovery, alerts, actionQueue, kpis,
  reflect, projects, workflows).
- The daemon HTTP API becomes a thin transport over the same services; the UI
  proxies it; `ui/server/db.ts` fallback projection logic is removed.
- The CLI command seam (ADR-0023) keeps its leaf-granular, transport-injected
  shape, but the injected transport now resolves to application services rather
  than ad-hoc store/daemon calls.
- An **arch-test** forbids projection logic outside the domain layer.

This is the realisation of "the daemon is fully separated from the display":
the daemon is one adapter among several over a display-agnostic service layer.

## Consequences

- Adding a surface (the TUI) is writing an adapter, not re-deriving views.
- The duplicated projection logic collapses to one implementation; ADR-0048/0051
  projection rules are enforced once.
- Skills may continue to shell out to the CLI (the CLI is itself a thin adapter),
  so "call the same functions" holds transitively without forcing every skill
  onto HTTP.
- Supersedes the implicit per-surface-read pattern; does not change ADR-0044
  (UI server may spawn daemons) — spawning is orthogonal to the read seam.
