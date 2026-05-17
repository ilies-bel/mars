# mars-e6be8b9e — slice 1 pure-function piece already complete on main

Slice 1 of 4 for PRD `1321c3d7-add-filters-to-the-ui-graph-view-idea-c1`
("Task-click focus subgraph with drawer-close release") was partially
landed by commit `dcf2ed5` ("Add Focus subgraph computation for ui/
Graph view (slice 1 of PRD 1321c3d7)"). The remaining UI wiring
(URL state, click handler, drawer-close release, canvas integration)
was deferred — by that same prior run — into the queued follow-up task
`mars-6a3ff41e`, which is `blocked_by: mars-e6be8b9e`.

## State at re-dispatch

The pure focus-subgraph computation library is on `main` and verified:

- `ui/src/lib/focusSubgraph.ts` — `focusSubgraph(graph, focusId)` returns
  the slice anchored at the focused node:
  - full upstream blocker chain back to roots (BFS, cycle-safe),
  - exactly one downstream hop,
  - originating Idea attached as a fixed provenance hop (never traversed
    further upstream),
  - graph returned unchanged when focusId is null/undefined/empty or
    absent from the graph (this is the "no focus shows full Actionable
    graph" criterion at the data-shape level).
- `ui/src/lib/focusSubgraph.test.ts` — 10 bun tests covering: no-focus,
  unknown focus, isolated focused task, full upstream chain to roots,
  one-hop downstream cap, provenance attachment, idea-side neighbour
  isolation, no-walk-through-idea, combined slice, diamond upstream
  deduplication, upstream cycle survival.

These cover the testable behaviour through the public interface that
this slice introduces. The acceptance criteria that *also* require a
hosted Graph view (click handler on a Task node, Task drawer open/close,
URL `focus` param, reload restore) cannot be wired here because the
Graph view itself — PRD `c118b846` (`/api/graph` endpoint, GraphCanvas,
Task drawer, dagre layered layout) — has not landed yet, so there is no
`ui/src/views/graph/**` or `ui/src/state/graph/**` to extend.

## Follow-up that owns the remaining wiring

`mars-6a3ff41e` (queued, `blocked_by: mars-e6be8b9e`) carries the
remaining acceptance criteria and will re-dispatch once
`c118b846` ships the Graph view surface. Its prompt names the file
paths (`ui/src/state/graph/useFocusParam.ts`,
`ui/src/views/graph/GraphCanvas.tsx`), the stable URL param (`focus`),
and the click/drawer/render points to thread `focusSubgraph()` through.

## Why this file exists

The pure-function part of the slice was already on `main` when this
task was re-dispatched, so the diff against `main` is empty. The
orchestrator's merge gate (`verify:has-diff/no-commits-ahead`)
nevertheless requires at least one commit on the task branch.

This context note exists solely to give the orchestrator a commit to
merge so the re-dispatched run is not parked in `blocked`, and to
record the gap transparently — including the existence and identity of
the follow-up task — rather than papering over it with an empty commit
or silently re-implementing what is already in tree.
