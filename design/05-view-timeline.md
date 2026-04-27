# 05 — View 3: Run timeline + inspector

The post-mortem and live monitor surface. One run, full detail.

## Wireframe

```
┌─────────────────────────────────────────────────────────────────────────┐
│  RUN  2026-04-27T14_22  · add oauth callback     ● live · 1m 04s · 24k  │
│  budget: 24k / 200k          parked: 0          inbox: 0 (+0 this run)  │
├─────────────────────────────────────────────────────────────────────────┤
│  TIMELINE                                                  INSPECTOR    │
│                                                          ┌────────────┐ │
│  14:22:00  ▶ run.start                  goal: add oauth  │ event #134 │ │
│            │                                             │            │ │
│  14:22:01  │   planner   ▮ 2.1s · 4k                     │ kind:      │ │
│            │       └── intent: plan (3 tasks)            │   agent.   │ │
│            │                                             │   intent   │ │
│  14:22:04  │   builder T1 ▮▮▮▮▮▮ 12.4s · 9k              │            │ │
│            │       └── intent: build (3 edits)           │ agent:     │ │
│            │       └── fs.apply ✓                        │   builder  │ │
│            │       └── vcs.checkpoint ✓ ref a1b2c3d      │   T1       │ │
│            │                                             │            │ │
│  14:22:17  │   reviewer T1 ▮▮ 4.0s · 3k                  │ taskId:    │ │
│            │       └── verdict: pass ✓                   │   7f3a91c2 │ │
│            │                                             │            │ │
│  14:22:21  │   builder T2 ▮▮▮▮ 7.8s · 6k                 │ tokensIn:  │ │
│            │       └── intent: question ❓               │   3104     │ │
│            │       └── inbox.add #7f3a-needs-scope       │ tokensOut: │ │
│            │       └── task → awaiting_human             │   1031     │ │
│            │                                             │            │ │
│  14:23:04  ●   builder T3 ▮▮▮ running…                   │ intent:    │ │
│            │                                             │ ┌────────┐ │ │
│                                                          │ │ {      │ │ │
│  ───────────────────────────────────────────────────     │ │  edits │ │ │
│  agents lane:  planner  T1▮  T2▮  T3▮▮▮                  │ │  ...   │ │ │
│  budget burn:  ▁▁▂▃▃▃▄▄▅▅▅▆▆▇▇▇                          │ │ }      │ │ │
│                                                          │ └────────┘ │ │
│  ⓘ  builder T2 parked on inbox item 7f3a-needs-scope     └────────────┘ │
│      $ mars answer 7f3a "<your answer>"                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

## Layout

Three stacked regions, left column is timeline, right column is
inspector.

1. **Header** — run identity, status, hot stats: duration, tokens,
   budget remaining, parked count, inbox delta.
2. **Timeline (left, ~70%)** — chronological event stream rendered as a
   vertical lane with horizontal duration bars per agent invocation.
3. **Inspector (right, ~30%)** — one event at a time, full payload.
4. **Bottom strip** — agent-lanes mini-map and budget-burn sparkline. The
   "did parallelism actually happen?" view.
5. **Affordance line** — context-sensitive hint. When a task is parked,
   shows the exact `mars answer` command (read-only — no copy button is
   needed because the line is selectable text).

## Event rendering rules

- One row per event from `events.db`, filtered by `runId`.
- Width of the duration bar = `durationMs`. Color = role
  (planner / builder / reviewer / orchestrator / adapter).
- Children indented under their parent: an `agent.spawn` row owns its
  `tool.call` and `intent.apply` rows, then closes with `agent.exit`.
- The intent payload is *not* shown inline — only its kind and a
  one-line summary. Click the row to load full payload in inspector.
  This is the difference between a wall-of-JSON and a navigable timeline.

## Inspector

Renders the selected event:

- **Header**: kind, agent, task, timestamps.
- **Body**: pretty-printed JSON of `payload`. Long arrays collapse by
  default with a count badge (`[edits: 12]`).
- **Errors**: `error.message` + `error.stack` rendered in a red panel,
  monospace, **expanded by default** so a failure never hides.

For `agent.intent` events, the inspector also shows:

- **Prompt** — collapsed by default. Expand to reveal the system prompt
  composed from `agents/<role>.md`. Reading the actual prompt that ran
  is the fastest path to understanding why the agent did what it did.
- **Token meter** — input vs output tokens, side by side, sized
  proportionally. Highlights chatty agents at a glance.

## Filters

Top-right of the timeline, two pills:

- **kind** — multi-select dropdown of `EventKind`. Default: all visible
  except `tool_start` (paired with `tool_end` to reduce noise).
- **errors only** — toggle. Hides everything but `error` + non-OK
  `*_end` events.

These are URL-state so a filtered view is shareable.

## Live behavior

While the SSE connection is open:

- New rows append to the bottom; viewport autoscrolls only if the user
  is already at the bottom.
- The `running…` row shows an indeterminate progress bar that estimates
  duration from prior runs of the same role + role's running median.
- Token counters increment as `agent.intent` events arrive.
- Once `run.end` arrives, the live indicator clears, autoscroll stops.

## Past run behavior

Same component, fed from `db.eventsForRun(runId)` instead of SSE. The
bottom strip and inspector behave identically. Only difference: the
header shows final status (`done` / `halted` / `failed`) instead of `live`.

## QA gates and inbox events

`qa_match`, `inbox_add`, and `inbox_resolve` events render with a
distinct icon and inline the inbox item title. Clicking expands to show
the matched paths / question prompt — the timeline becomes the primary
explanation of *why* an item is in the inbox.

## Errors

`error` events get a permanent red highlight and a sticky pin in the
mini-map. Easy to find on a long timeline.

## What's deliberately absent

- No "rerun" button. Reruns are a CLI operation.
- No "edit task" button. Plans are mutated only by the planner agent or
  by `mars retro --apply`.
- No comments, no sharing, no annotations. Use git on the run JSONL if
  you really want notes.
- No latency p50/p95 widgets — those live in `mars audit`. The timeline
  is for one run; audit is for trends.
