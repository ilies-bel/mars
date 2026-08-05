# Follow-up tasks inherit their origin's arc; synthetic followup origin_ids are removed

## Context

The glossary defines an Arc as the tree of work sharing one `origin_id`
(CONTEXT.md). Two follow-up creation paths currently break that grouping by
writing a NON-canonical `origin_id`, so the follow-up belongs to no arc and is
unreachable from the origin it continues:

1. `mars task add --blocked-by <id>` follow-ups keep `origin_id = self` — a
   coder emitting a "I'm blocked, here's the follow-up" task creates a node in
   its own one-task arc, with only a `task_blockers` edge to the parent. The
   user reported exactly this: "this task is a follow-up for another task but
   the chain was incomplete — there was no reference from one to another."

2. Context-exhausted and exploration-loop follow-ups (`enqueueFollowUpOnce`,
   queue.ts) write a SYNTHETIC `origin_id` of the form
   `followup:<originTaskId>:<kind>`. That string is a once-only DEDUP key
   smuggled into the arc-identity column. Because it is not a real task/proposal
   id, `readTaskRow(originId)` returns null and the follow-up renders as a lone
   node belonging to no arc.

## Decision

A follow-up task is a continuation of the SAME work and therefore belongs to
the SAME arc as the task it follows. Concretely:

- A `--blocked-by` follow-up and a context-exhausted / exploration follow-up
  both INHERIT the origin's resolved `origin_id` (i.e. they share the parent's
  arc key), rather than self-assigning or using a synthetic value.
- The once-only dedup that previously rode on
  `origin_id = followup:<id>:<kind>` moves OFF `origin_id` onto a dedicated
  dedup column/index, so arc identity and dedup identity are no longer
  conflated.

## Reconciliation with ADR-0040 (recovery tasks are leaf nodes)

This does NOT contradict ADR-0040. ADR-0040 governs `kind='fix'` recovery
tasks and the `task_blockers` graph: a recovery task cannot have blockers,
cannot be blocked, and the blocker-cascade does not recurse through it.

Follow-up tasks here are regular `kind='task'` tasks, and arc inheritance is
expressed through the `origin_id` COLUMN, not through a `task_blockers` edge.
No recovery edge is created; the leaf-node invariant and its three enforcement
points are untouched. A `--blocked-by` follow-up still gets its blocker edge
exactly as before — what changes is only which arc the `origin_id` column
places it in.

## Consequences

- Follow-ups become reachable from their origin's arc in the origin-tree,
  action queue, and topology — closing the "incomplete chain" the user hit.
- Arc membership now means "shares origin_id" uniformly; dependency edges
  (`task_blockers`) remain a separate concern shown as edges, not as arc
  identity.
- The synthetic `followup:` origin_id is removed; a migration cleans existing
  rows that carry it, re-pointing them at the real origin's `origin_id`.
