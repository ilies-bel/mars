# Workflow instance

A single execution of a Workflow against an origin row — a Task in the task-scoped case (Coder, Writer, Fixer, plus setup/verify/merge/recovery) or a Proposal in the proposal-scoped case (Planner, Slicer, Triager). The origin row's id is the Workflow instance's identity; the orchestrator resolves tag plus task type to exactly one Workflow id and records it on the origin row at dispatch. The instance carries durable per-step state (last completed step, step input/output payloads, child-logger lineage) so a crash resumes from the last completed step on retry.

_Avoid_: workflow run, run, task run, workflow execution
