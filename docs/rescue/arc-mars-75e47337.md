# Rescue Assessment — Arc mars-75e47337

**Date:** 2026-08-18
**Rescue task:** mars-ec8b2e0a
**Failed task:** mars-75e47337
**Failure signature:** code:context-exhausted/unclassified

## What failed

`mars-75e47337` asked for a fix to `maybeSpawnRescueOperator`
(`orchestrator/src/core/rescue-operator-spawn.ts`): add an in-flight-recovery
guard so a rescue is not spawned while the arc's ordinary one-recovery-per-
origin fix task is still `queued`/`running` (that guard, once the fix lands,
would have prevented this very rescue dispatch — see below). The coder run
on `mars-75e47337` ran out of context before committing
(`code:context-exhausted/unclassified`), leaving 5 files staged but
uncommitted on `task/mars-75e47337`. The orchestrator spawned the standard
one-recovery-per-origin fix task, `fix-539204ee`, on that same worktree/branch.

## Arc state at rescue arrival

| task | status at rescue | notes |
|------|-------------------|-------|
| mars-75e47337 | blocked | waiting on fix task |
| fix-539204ee | **running** | recovery coder active on the same worktree, started ~1 min before this rescue ran |

`fix-539204ee` was already `running` (confirmed live in
`mars daemon status` → `inFlight: implement fix-539204ee`) with 5 files
staged in the worktree matching the scope of the requested fix
(`rescue-operator-spawn.ts`, `queue-fix-tasks.ts`, `task-store.ts`, and
their tests) — legitimate salvageable progress, not a stalled run.

This is exactly the "rescue spawned while a recovery is already in-flight"
scenario the origin task itself describes as the root cause of two-thirds
of rescue-operator no-ops (see `RESCUE-mars-3dcef8b5.md` precedent cited in
the task prompt). Ironically, `mars-75e47337`'s own fix — once merged — will
stop this exact rescue from being spawned in the future.

## Actions taken

Ran `mars continue mars-75e47337` to confirm the correct corrective path.
It refused, as expected:

```
mars-75e47337: task mars-75e47337 already has an in-flight recovery
fix-539204ee; wait for it to complete or use 'mars restart' to discard
and re-run
```

**Verdict: continue** — `fix-539204ee` is the active recovery with real
salvageable progress on-scope for the original task. No restart (would
discard good partial work) or supersede (the original prompt is correct;
nothing about the approach is flawed) is warranted. The arc-rescue
counter was not consumed by any destructive action here.

## Prevention

Once `fix-539204ee` lands the in-flight-recovery guard in
`maybeSpawnRescueOperator`, this class of rescue dispatch (arriving after
the ordinary recovery is already running) will short-circuit to
`{ spawned: false }` before the arc-rescue counter increments, instead of
burning a full rescue-operator run to reach the same "continue" verdict
observed here.
