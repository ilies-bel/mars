# Step span

A persisted record of one Workflow-instance step's execution (started_at, ended_at, outcome); the steps are setup, code, verify, merge and recovery steps. A Step span whose step is a claude -p execution is a Session and additionally carries a Worker and a Claude session id; non-LLM steps have neither.

_Avoid_: step record, step run, span, workflow step, phase
