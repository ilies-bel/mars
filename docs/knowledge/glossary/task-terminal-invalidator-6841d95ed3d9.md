# task-terminal invalidator

The first concrete Invalidator kind: auto-attached to any inbox item raised with a structured taskId, it closes that item when a task.terminal bus event reports its task reached done or dropped (failed is excluded — the operator owns failed-task items).

_Avoid_: stale-closer, task-done invalidator, terminal sweep
