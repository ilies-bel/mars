# Live task

A task routed to a workflow whose code step has Execution mode manual: setup runs auto, the task parks awaiting-human at the manual step, and a Foreground session does the work before verify and merge gate the exit.

_Avoid_: foreground task, manual task, interactive task
