# Gate tier

Classification on every verify gate: 'task' gates are cheap and run per-task in the worktree (typecheck, lint, diff-affected tests, completeness); 'integration' gates are expensive and run once, serialized under the merge lock, against the merged tree (full suites).

_Avoid_: verify level, check tier
