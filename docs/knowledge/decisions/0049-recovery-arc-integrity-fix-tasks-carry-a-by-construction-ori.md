# Recovery-arc integrity: fix tasks carry a by-construction origin edge and purge cascades the arc

## Context

A failed task spawns exactly one recovery task (kind='fix'), linked to its
origin via the soft pointer `fix_for_task_id`. Two gaps in that model produce
"synchronisation" symptoms in the action queue:

1. **Purge orphans the recovery.** `dropTask` deliberately NULLs
   `fix_for_task_id` on a purged origin's recovery tasks rather than removing
   them ("Set NULL is the honest post-drop state"). The recovery survives
   pointing at nothing; its action-queue row references the now-deleted origin
   and 500s with `task <id> not found`, making the row impossible to clear.

2. **The origin edge is only a convention.** `fix_for_task_id` is nullable and
   not enforced, so a fix task can exist with no origin link — an orphan from
   birth. ADR-0040 made recovery tasks leaf nodes; this ADR adds the missing
   half: a fix task must be linked to its origin *by construction*.

## Decision

The recovery arc (origin + its fix task) is an integrity unit.

- **By-construction origin edge.** For `kind='fix'` tasks, `fix_for_task_id` is
  NOT-NULL-enforced at insert. A fix task cannot exist without its origin.
  A migration cleans/backfills any existing null-edged fix rows.

- **Purge cascades the arc.** Purging an origin atomically deletes the origin
  and every fix task pointing at it. Recoveries never outlive their origin;
  the null-out-on-drop behaviour is removed.

## Consequences

- The `fixForRefsCleared` null-out path in `dropTask` is removed/replaced by
  cascade deletion. Callers that relied on the surviving-orphan behaviour
  (none expected) must move.
- Action-queue rows can no longer reference a deleted origin, eliminating the
  `task not found` 500 on purge.
- This extends, and does not contradict, ADR-0040 (recovery tasks are leaf
  nodes): the single legitimate origin→fix edge is now mandatory, not optional.
