# Task

A queued unit of work expected to produce one or more commits on a task/<id> branch, which the orchestrator verifies (verify:has-diff + .mars/verify.json) and fast-forwards into the integration branch.

_Avoid_: job, run
