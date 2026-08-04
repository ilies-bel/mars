# awaiting-human (task)

Parked task state: the workflow suspended at an awaitHuman step and a human may take the Lease and work in the task's worktree in their own session. Pipeline resumes at verify on release. Generalizes the --preview awaiting-validation gate.

_Avoid_: paused, parked, HITL state
