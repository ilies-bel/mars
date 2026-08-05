# task-terminal invalidator closes on done/dropped only, never failed

task.terminal fires for done, dropped, and failed. The task-terminal invalidator kind's matcher deliberately excludes failed: a failed task gets exactly one actionable inbox item the operator must resolve explicitly, so auto-closing on failed would silence the signal precisely when a human is needed. dropped is included (intentionally abandoned work makes its items moot). The staleness pain is exclusively successful-terminal-via-another-path; failed items are live, not stale.
