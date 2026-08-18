# Rescue Assessment — Arc mars-e4720f97

**Date:** 2026-08-18
**Rescue task:** mars-2bb1d005
**Failed task:** mars-e4720f97
**Failure signature:** unknown/unclassified

## What failed

`mars-e4720f97` asked for `mars continue`'s recovery-exhausted refusal to
become branch-aware: today it offers only `restart` (discard) or `drop`
(delete) even when the arc's branch holds real salvageable commits, which
inverts CLAUDE.md's "continue before restart" guidance whenever the
recovery budget is spent. The coder committed `3f5b2a83` ("fix(continue):
name salvageable commits in recovery-exhausted refusal") on
`task/mars-e4720f97`, then failed verify — the stored error is truncated
to its last 2000 chars, which shows only a tail of passing
`syncWorktreeToIntegration` tests in the orchestrator daemon suite, not
the actual failing assertion. The orchestrator spawned the standard
one-recovery-per-origin fix task, `fix-26fd9767`, on that same
worktree/branch.

## Arc state at rescue arrival

| task | status at rescue | notes |
|------|-------------------|-------|
| mars-e4720f97 | blocked | waiting on fix task |
| fix-26fd9767 | **running** | recovery coder active on the same worktree; created at the same instant (08-18 17:55:45) as this rescue task |

The rescue dispatch's own snapshot (embedded in the rescue prompt) listed
`fix-26fd9767` as `queued`; by the time this assessment ran, `mars daemon
status` confirmed it live: `inFlight: implement fix-26fd9767` (alongside
`implement fix-ae5c2645` and `implement mars-2bb1d005` itself). The
worktree at `task/mars-e4720f97` is clean (no staged/unstaged diff beyond
the origin's own `3f5b2a83`), consistent with the recovery coder having
just started rather than having stalled.

This is the same "rescue spawned while a recovery is already in-flight"
race documented in `docs/rescue/arc-mars-75e47337.md` and
`docs/rescue/arc-mars-afea27b7.md`, fixed by `d2cfce4b` (`fix(rescue):
skip rescue spawn while arc recovery is in flight`) — already merged to
`main` and present in this worktree's history. The guard didn't prevent
this dispatch for the same reason as those two prior cases: the *running
daemon process* still executes older code —

```
⚠ running code from 1609d7f; HEAD is now 4b8c157 — run `mars daemon restart`
```

— so `fix-26fd9767` and this rescue (`mars-2bb1d005`) were both spawned
by `handleTaskFailureWithFixTask` before the in-flight-recovery check
could see the fix task it had just created.

## Actions taken

Ran `mars continue mars-e4720f97` to confirm the correct corrective path.
It refused, as expected:

```
mars-e4720f97: task mars-e4720f97 already has an in-flight recovery
fix-26fd9767; wait for it to complete or use 'mars restart' to discard
and re-run
```

**Verdict: continue** — `fix-26fd9767` is the active recovery, resuming
from the origin's own on-scope commit `3f5b2a83`. No restart (would
discard that commit and force the recovery coder to redo the diagnosis)
or supersede (the original prompt and approach are sound; the failure was
a verify-step break, not a flawed plan) is warranted. The arc-rescue
counter was not consumed by any destructive action here.

## Prevention

No new prevention work is needed beyond what `d2cfce4b` already lands:
this is the third occurrence of the identical "daemon running stale code"
race (after `mars-75e47337` and `mars-afea27b7`), and all three converge
on the same root cause — a `mars daemon restart` has not yet been run to
pick up the merged guard. Once that restart happens, this class of rescue
dispatch will short-circuit to `{ spawned: false }` before the arc-rescue
counter increments, instead of burning a full rescue-operator run to
reach the same "continue" verdict observed here (and in the two prior
assessments).
