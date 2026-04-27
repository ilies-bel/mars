# 03 — View 1: Topology

The static agent graph from `mars.flow.ts`. Renders identically whether
or not a run is live. **This is documentation that runs.**

## Wireframe

```
┌─────────────────────────────────────────────────────────────────────────┐
│  TOPOLOGY                                              flow: mars.flow  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│      ┌──────────┐                                                       │
│      │ Goal     │                                                       │
│      └────┬─────┘                                                       │
│           │ Goal                                                        │
│           ▼                                                             │
│      ┌──────────┐    Plan                                               │
│      │ planner  │─────────────▶  PlanStore                              │
│      └──────────┘                    │                                  │
│                                      │ Task                             │
│                                      ▼                                  │
│      ┌──────────┐    BuildResult ┌──────────┐                           │
│      │ builder  │ ◀─── FS ─────  │  next()  │                           │
│      └────┬─────┘                └──────────┘                           │
│           │ BuildResult                                                 │
│           ▼                                                             │
│      ┌──────────┐    Review                                             │
│      │ reviewer │────────────────┐                                      │
│      └──────────┘                │ needs-changes                        │
│           │ pass                 │                                      │
│           ▼                      ▼                                      │
│      ┌──────────┐           (back to builder)                           │
│      │  done    │                                                       │
│      └──────────┘                                                       │
│                                                                         │
│  ──────────────────────────────────────────────────────────────────     │
│  Selected: builder                                                      │
│    in:  Task                                                            │
│    out: BuildResult                                                     │
│    tools: fs-read, ripgrep, rtk, exec                                   │
│    template: agents/builder.md   (last edited 3h ago)                   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Source of truth

`mars.flow.ts` is imported and resolved server-side at boot. The Hono
server serializes the resolved `defineFlow({...})` value to JSON and
hands it to the client at `/api/flow`. **No duplicate diagram lives in
the UI codebase** — the picture and the wiring are the same export.

## Components

- **Graph** — React Flow. Custom node types per role (planner / builder /
  reviewer). Custom edge type to label the typed intent (`Plan`,
  `BuildResult`, `Review`) and the via-adapter (`PlanStore`, `FS`, …).
- **Inspector panel** — bottom 30% on wide viewports, right-side drawer
  on narrow. Shows the selected node's frontmatter (from
  `agents/<role>.md`) and its tool allowlist (from the resolved
  `ToolRegistry`).
- **Goal & Done nodes** are virtual (not in the agents table) — they
  visualize the entry and exit of the flow. Styled distinctly (rounded
  rect vs square).

## Interactions (read-only)

- Click a node → inspector populates. URL updates to `/topology#builder`.
- Click an edge → inspector shows the intent type + a code block of its
  TS shape from `CONTRACTS.md` §5.
- Click `agents/builder.md` link → opens the file in `$EDITOR` via a
  passthrough that resolves to `vscode://file/<abs-path>` (or whatever is
  configured). UI never reads or rewrites the file.

## Live overlay (optional, off by default)

When a run is live, nodes light up while their role is executing
(`agent_spawn` event arrives, `agent_exit` un-lights). Edges briefly
animate when the corresponding intent is applied.

This is **purely decorative** — clicking a lit node doesn't take you to
the run; the explicit Run tab does that. Lighting up the topology while
something is happening is a sanity check that the wiring matches the
config.

A toggle in the top-right of the view turns the overlay off for users
who find it distracting.

## Empty state

There is no empty state — `mars.flow.ts` is required by the compiler. If
the file is missing, the Hono server fails to boot with a clear error,
not a half-broken UI.
