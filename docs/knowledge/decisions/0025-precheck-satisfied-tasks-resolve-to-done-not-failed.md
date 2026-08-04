# Precheck-satisfied tasks resolve to done, not failed

When the context-gathering precheck confirms verify-on-main passes for a too-hard-tripped task, the task is resolved to 'done' (dependents auto-unblock) and an inbox signal is raised. This breaks the implicit invariant that 'done means this task produced the commit', because the commit was produced by an earlier task or human. We accept that break: status should reflect that the deliverable is on main, and the inbox signal surfaces recurring slicer misfires without forcing the operator to triage each correct precheck hit.
