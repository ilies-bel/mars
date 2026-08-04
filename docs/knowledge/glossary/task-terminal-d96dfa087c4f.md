# task.terminal

A bus event emitted at the single TaskStore status-write chokepoint whenever a task reaches a terminal state (done, dropped, or failed), carrying { taskId, state }. Distinct from task.completed, which fires per workflow run rather than per task-state transition.

_Avoid_: task.done, terminal event, task-state event
