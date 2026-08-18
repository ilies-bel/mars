# Rescue Assessment — Arc mars-afea27b7

**Date:** 2026-08-18
**Rescue task:** mars-6f52a319
**Failed task:** mars-afea27b7
**Failure signature:** unknown/unclassified

## What failed

`mars-afea27b7` asked for the phantom-in-flight-sweep reconciler to be
finished and landed (carried forward from the exhausted arc
`mars-6340b827`). Its coder run committed `e207c792` ("add
phantom-in-flight-sweep safety net for stalled verifying tasks") but then
failed verify: `cd orchestrator && npm run typecheck && npx vitest run
src/core/daemon` hit a pre-existing, unrelated failure in
`restart-resolves-action-queue.test.ts` (`Illegal task status transition:
task mars-aebde292 is in terminal status 'failed' and cannot transition to
'done'`). The orchestrator spawned the standard one-recovery-per-origin fix
task, `fix-ae5c2645`, on that same worktree/branch.

## Arc state at rescue arrival

| task | status | notes |
|------|--------|-------|
| mars-afea27b7 | blocked | waiting on fix task |
| fix-ae5c2645 | **running** | recovery coder active on the same worktree; `mars daemon status` shows `inFlight: implement fix-ae5c2645` |

The rescue dispatch's own snapshot (embedded in the rescue prompt) listed
`fix-ae5c2645` as `queued`, but by the time this assessment ran the daemon
had already dispatched it — confirmed live via `mars daemon status`
(`inFlight: implement fix-ae5c2645`) and by git state in the worktree:
commit `e207c792` is on the branch, and 9 files are staged with active,
uncommitted edits (416 deletions / 9 insertions) that scope down the
original safety-net commit — consistent with the coder actively working
STEP 4 of the recovery prompt ("finish or fix"), not a stalled run.

This is the same "rescue spawned while a recovery is already in-flight"
race documented in `docs/rescue/arc-mars-75e47337.md` and fixed by
`d2cfce4b` (`fix(rescue): skip rescue spawn while arc recovery is in
flight`) — already merged to `main` and present in this worktree's history.
The guard didn't prevent this dispatch because the *running daemon process*
still executes older code (`mars daemon status` warns `running code from
1609d7f; HEAD is now d2cfce4 — run 'mars daemon restart'`); a daemon
restart will pick up the guard and stop this exact race going forward (see
Prevention).

## Actions taken

Ran `mars continue mars-afea27b7` to confirm the correct corrective path.
It refused, as expected:

```
mars-afea27b7: task mars-afea27b7 already has an in-flight recovery
fix-ae5c2645; wait for it to complete or use 'mars restart' to discard
and re-run
```

**Verdict: continue** — `fix-ae5c2645` is the active recovery with real
salvageable progress (commit `e207c792` plus in-progress staged edits)
on-scope for the original task. No restart (would discard active coder
work mid-edit) or supersede (the original prompt and approach are sound;
the failure was an unrelated pre-existing test, not a flawed plan) is
warranted. The arc-rescue counter was not consumed by any destructive
action here.

## Prevention

The daemon needs a restart to run the merged `d2cfce4b` in-flight-recovery
guard, at which point this class of rescue dispatch (arriving after the
ordinary recovery is already running) will short-circuit to
`{ spawned: false }` before the arc-rescue counter increments, instead of
burning a full rescue-operator run to reach the same "continue" verdict
observed here.
