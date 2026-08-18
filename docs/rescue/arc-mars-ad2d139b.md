# Rescue Assessment — Arc mars-ad2d139b

**Date:** 2026-08-18
**Rescue task:** mars-6be65010
**Failed task:** mars-ad2d139b
**Failure signature:** unknown/unclassified

## What failed

`mars-ad2d139b` documents that `main` is red: 31 pre-existing failures in
`src/core/daemon` (timestamp-encoding mix-ups, illegal terminal-status
transitions, and other clusters) poison the verify step of every
daemon-scoped task, since the branch and merge-base failure sets are
identical. `mars-ad2d139b` itself is the task carrying that
investigation/fix and failed verify (`failed_phase: verify`), which spawned
the standard one-recovery-per-origin fix task, `fix-983e7c26`, on the same
worktree/branch.

## Arc state at rescue arrival

| task | status at rescue arrival | status now | notes |
|------|---------------------------|-------------|-------|
| mars-ad2d139b | blocked | blocked | waiting on fix task |
| fix-983e7c26 | queued (per dispatch snapshot) | **running** | recovery coder active on the same worktree (`.mars/worktrees/mars-ad2d139b`, branch `task/mars-ad2d139b`) |

`mars daemon status` confirms it live: `inFlight: implement fix-983e7c26`
(alongside `implement mars-6be65010`, this rescue task itself).

This is the same "rescue spawned while a recovery is already in-flight"
race documented in `docs/rescue/arc-mars-75e47337.md`,
`docs/rescue/arc-mars-afea27b7.md`, and `docs/rescue/arc-mars-e4720f97.md`,
fixed by `d2cfce4b` (`fix(rescue): skip rescue spawn while arc recovery is
in flight`) — already merged to `main` and present in this worktree's
history. The guard didn't prevent this dispatch for the same reason as
those three prior cases: the *running daemon process* still executes older
code —

```
⚠ running code from 1609d7f; HEAD is now 8cd6efa — run `mars daemon restart`
```

— so `fix-983e7c26` and this rescue (`mars-6be65010`) were both spawned by
`handleTaskFailureWithFixTask` before the in-flight-recovery check could
see the fix task it had just created.

## Actions taken

Ran `mars continue mars-ad2d139b` to confirm the correct corrective path.
It refused, as expected:

```
mars-ad2d139b: task mars-ad2d139b already has an in-flight recovery
fix-983e7c26; wait for it to complete or use 'mars restart' to discard and
re-run
```

**Verdict: continue** — `fix-983e7c26` is the active recovery on
`task/mars-ad2d139b`. No restart (would discard the recovery coder's
in-progress work and force it to redo the diagnosis) or supersede (the
original prompt and investigation are sound; this is a verify-step
failure, not a flawed plan) is warranted. The arc-rescue counter was not
consumed by any destructive action here.

## Prevention

No new prevention work is needed beyond what `d2cfce4b` already lands:
this is the fourth occurrence of the identical "daemon running stale code"
race (after `mars-75e47337`, `mars-afea27b7`, and `mars-e4720f97`), and all
four converge on the same root cause — `mars daemon restart` has not yet
been run to pick up the merged guard. Once that restart happens, this
class of rescue dispatch will short-circuit to `{ spawned: false }` before
the arc-rescue counter increments, instead of burning a full
rescue-operator run to reach the same "continue" verdict observed here
(and in the three prior assessments).
