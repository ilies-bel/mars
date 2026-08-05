# One Action abstraction kind-routed to a workflow; Tree = Proposal + its Arcs

## Status

Proposed (DDD restructure strategy).

## Context

The domain today has `TaskKind = 'task' | 'fix' | 'diagnose'` plus an implicit
"structured-write" task, and separate informal concepts (Task, Recovery, Probe,
Structured-write) that share a lifecycle but are modelled ad-hoc. Dispatch
routes on **status**, not on what kind of work the unit is. Separately, the
glossary has `Arc` (origin_id group) and `Proposal` (the pre-slice idea) but no
modelled relationship between an idea and the many arcs sliced from it — the user
calls that grouping a "tree".

## Decision

**One Action abstraction.** A single `Action` entity carries a `kind`
(`task | fix | diagnose | write`); `kind` selects the workflow:

- `task` → implement workflow (setup → code → verify → merge)
- `fix` → recovery workflow (Fixer worker)
- `diagnose` → probe workflow (read-only; never commits)
- `write` → structured-write workflow

`Action.selectsWorkflow()` is the routing function; the dispatcher routes on
`kind`, not status. This generalises the existing `TaskKind` enum and the
ad-hoc structured-write path into one polymorphic entity owned by the Arc
aggregate (ADR-0052).

**Tree = Proposal + its Arcs.** A `Tree` is an idea and all the work sliced from
it: a `Proposal` plus every `Arc` derived from it. A standalone `mars task add`
with no proposal is a **one-Arc Tree** (`proposal = null`). This gives a clean
three-level hierarchy — Tree ⊇ Proposal, Tree ⊇ Arc[] ⊇ Action[] — and a
modelled home for the proposal→many-arcs grouping the UI topology already wants.

## Consequences

- `kind` becomes the dispatch axis; status stays the lifecycle axis. The two
  are orthogonal and no longer conflated in the dispatch switch.
- The glossary gains `Tree` and sharpens `Action` (see `aggregate-catalog.md`);
  `Arc` and `Proposal` definitions are unchanged.
- New CLI surface: `mars tree list` / `mars tree show <id>` render a Tree as one
  unit. `mars arc show` is enriched but Tree is the new grouping verb.
- Recovery (`fix`) and Probe (`diagnose`) keep their ADR-0040/0049 invariants —
  they are Actions of a particular kind, still leaf nodes, still carrying the
  by-construction origin edge.
- This does not contradict ADR-0026 (rename idea→proposal): Tree is a grouping
  *over* proposals/arcs, not a rename of either.
