# Rescue assessment — arc mars-66454c77 (merge-worktree-vanished)

**Date:** 2026-08-12  
**Rescue task:** mars-7a282d8c (this task; stopped by operator before acting)  
**Recovery of rescue task:** fix-e9d4929e  
**Failed task:** mars-66454c77 (fix merge job crash when worktree deleted mid-merge)  
**Recovery task:** fix-b5c9356a (failed — stopped by operator)

## What happened

`mars-66454c77` was auto-failed by the phantom-task watchdog (`reason: dead-pid`,
`observation: worker PID 95304 was not alive when checked`, task age: 0 min). The
failure was a transient infrastructure event — the worker process exited before the
watchdog's next liveness check.

The rescue-operator task `mars-7a282d8c` was spawned to assess the dead-ended arc
and choose an action (restart / continue / supersede). The operator stopped it via
`mars task stop` before it could act. Recovery task `fix-b5c9356a` was also stopped
by the operator.

## State at rescue time

The task had **already completed its work** before the watchdog fired. The commits
for the worktree-vanished fix landed on `main`:

```
0ff7a5c3 fix(merge): guard against worktree-vanished crash in merge worker
3d6d5acc fix(merge): diagnose and auto-remerge worktree-vanished crash
```

`mars task show mars-66454c77` reports `Status: done`. The branch `task/mars-66454c77`
has no commits ahead of `main` (branch tip already merged).

The three goals from the original task prompt are satisfied on `main`:

1. ✅ The merge step fails with a diagnosable signature (`merge:worktree-vanished`)
   instead of `merge:crashed/unclassified`.
2. ✅ A recipe maps `merge:worktree-vanished` → remerge so the arc resolves without
   operator involvement.
3. ✅ The merge step verifies the working directory exists before spawning subprocesses.

## Arc status

| Task | Status | Notes |
|---|---|---|
| mars-66454c77 | done | Work merged to main; watchdog was a false-positive |
| fix-b5c9356a | failed | Stopped by operator; moot since origin is done |
| mars-7a282d8c | completing | Rescue-operator; no code action needed |

## Verdict

**Supersede.** The arc is fully resolved. No restart, continue, or additional code
change is needed. The operator-stopped tasks (`mars-7a282d8c`, `fix-b5c9356a`) can
be left in their terminal states; the original work is live on `main`.

```json
{"action":"supersede","reason":"origin done — work already merged to main before watchdog fired"}
```
