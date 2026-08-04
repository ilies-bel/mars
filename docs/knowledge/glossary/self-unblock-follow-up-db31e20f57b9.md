# Self-unblock follow-up

A Task filed by the Coder of the currently-running Task via 'mars task add --blocks $TASK_ID', creating a task_blockers edge in which the current Task waits on the new follow-up; the workflow short-circuits the current Task to blocked before verify and re-dispatches it once the follow-up reaches done.

_Avoid_: self-block, unblock task, blocked-by self
