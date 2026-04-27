# 02 — App Shell

Single shell wraps every view. Lives at `localhost:7777/`.

## Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ◆ mars   TOPOLOGY  RUNS  RUN 2026-04-27T14_22         ● live  v0.1.0   │ ← top bar
├──────┬──────────────────────────────────────────────────────────────────┤
│ ▸ FL │                                                                  │
│   ow │                                                                  │
│   pl │                                                                  │
│   bd │                  ────  view region  ────                         │ ← rail + view
│   rv │                                                                  │
│ ▸ RU │                                                                  │
│   ns │                                                                  │
│      │                                                                  │
├──────┴──────────────────────────────────────────────────────────────────┤
│ inbox: 1 blocker · 2 high · 7 open    budget 142k/200k     ⌃C to stop   │ ← footer
└─────────────────────────────────────────────────────────────────────────┘
```

## Top bar

- **`◆ mars`** — wordmark, links to `/` (Topology).
- **Tabs** — three deep links: `/topology`, `/runs`, `/runs/<id>`.
  - `RUN <id>` tab only appears when a run-detail page is open; closes the
    rest don't.
- **Live indicator** — green dot when an SSE connection is live, gray
  when no run is active. Hovering shows last event timestamp.
- **Version** — `mars` package version. Click reveals resolved adapter
  list (Provider: claude, PlanStore: beads, …) for one-click sanity check.

No search box, no profile menu, no theme switcher. Theme follows OS
(`prefers-color-scheme`).

## Left rail

Compact icon rail. Two clusters:

- **FLOW** — drill into a single agent's contract from the topology view.
  - `pl` planner
  - `bd` builder
  - `rv` reviewer
- **RUNS** — current + recent. Live run pinned at top with a pulsing dot.

The rail is **navigation only**, never controls. It collapses to icons on
narrow viewports.

## View region

Whatever component the route renders. Padded `2rem`. Scrolls
independently of the shell.

## Footer (status bar)

Always visible. Three slots, left to right:

1. **Inbox summary** — `N blockers · M high · K total open`. Counts come
   from `.mars/inbox.jsonl`. Clicking opens an in-page disclosure that
   lists item titles + the CLI command to triage them. **Never a form.**
2. **Budget** — `<used>k/<cap>k` for the active run; current vs config
   for idle.
3. **Hint** — context-sensitive. Live run shows `⌃C in CLI to stop`. Idle
   shows `$ mars build`.

The footer is the always-on answer to "what does mars need from me?"

## Routing

```
/                       → /topology
/topology               → View 1
/runs                   → View 2
/runs/:runId            → View 3
/runs/:runId/event/:id  → View 3, deep-linked to one event
```

Deep links to events matter for sharing post-mortems with future-you.

## Keyboard

Minimal. Solo dev, terminal-adjacent — keep finger memory on the CLI.

| Key | Action |
|---|---|
| `g t` | Topology |
| `g r` | Runs |
| `j` / `k` | Next / prev event in timeline |
| `?` | Cheatsheet overlay |
| `Esc` | Close any disclosure / overlay |

No global shortcuts that take focus from the page (e.g. `/` for search) —
there is no search.
