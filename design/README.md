# Mars UI — Design Drafts

> **Status:** v0 draft
> **Date:** 2026-04-27
> **Companion to:** [`../VISION.md`](../VISION.md), [`../docs/CONTRACTS.md`](../docs/CONTRACTS.md)

The `mars ui` dashboard is a **read-only local viewer** for Mars runs. Boots
with `mars ui`, foreground only, default port `7777`. The CLI is the only
control surface — the UI never writes back.

## Files

| File | Purpose |
|---|---|
| `01-principles.md` | Locked UI principles (read-only, single shell, no chrome) |
| `02-shell.md` | App shell: top bar, left rail, view region, status footer |
| `03-view-topology.md` | View 1 — static agent graph from `mars.flow.ts` |
| `04-view-runs.md` | View 2 — list of runs from `runs/` |
| `05-view-timeline.md` | View 3 — run timeline + intent inspector |
| `06-data-flow.md` | SSE wiring, polling, file→view binding |
| `07-styling.md` | Tailwind tokens, palette, typography, density |

## At a glance

```
┌─ mars ui ─────────────────────────────────────────────────────────────┐
│ TOPOLOGY  RUNS  RUN <id>                              ● live  7777    │
├──────┬────────────────────────────────────────────────────────────────┤
│      │                                                                │
│ rail │                       view region                              │
│      │                                                                │
├──────┴────────────────────────────────────────────────────────────────┤
│ inbox: 1 blocker · 2 high · 7 open       budget 142k/200k    ⌃C stops │
└───────────────────────────────────────────────────────────────────────┘
```

Three views, one shell, one event stream. No modals, no toasts, no
notifications, no settings page — anything that would belong in settings
belongs in `mars.config.ts` instead.
