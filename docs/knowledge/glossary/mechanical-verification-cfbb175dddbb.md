# Mechanical verification

The deterministic verify step: it runs configured shell checks such as typecheck, lint, targeted tests, and commit/diff assertions in a task worktree. It is authoritative for mechanical correctness and is serialized by the global verify lock; it does not assess human-facing behaviour.

_Avoid_: agent verification, agent verify, shell verification
