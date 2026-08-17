# Rescue assessment: arc mars-1375ab0b (daemon restart strands system)

**Rescue operator task:** mars-5642b28e  
**Arc origin task:** mars-1375ab0b (status: blocked)  
**Recovery task:** fix-ce8db22b (status: verifying at assessment time)  
**Verdict:** continue — recovery is in-flight and viable

## What happened

`mars-1375ab0b` was filed to fix a daemon restart race: the old daemon
process could survive the socket-down signal (wedged merge child keeping
the event loop alive), while the new child found its PID alive in
`daemon.lock` and exited with "holds the exclusive startup lock; refusing
to start" — leaving no daemon at all.

The task's recovery slot was spent on `fix-ce8db22b`. When the rescue
operator was dispatched, `fix-ce8db22b` had already progressed to
`verifying` state, meaning the fix commit was fully authored and awaiting
the verify/merge gate.

## Fix summary (commit 2b5a321d on branch task/mars-1375ab0b)

Two-layer fix applied by the prior recovery agent:

1. **CLI restart path** (`orchestrator/src/cli/commands/daemon.ts`): after
   the socket disappears, also wait up to 10 s for the actual OS process
   to exit, escalating SIGTERM → SIGKILL. This closes the race window where
   the old daemon deletes its socket while still running.

2. **Startup lock** (`orchestrator/src/core/daemon/server.ts`): instead of
   refusing immediately when the lock holder is alive, wait up to 15 s for
   it to exit. If it exits in time, proceed; if not, log a clear error and
   exit 1. Turns a silent "no daemon at all" state into a loud failure.

Both changes pass `npm run typecheck` and `npx vitest run src/core/daemon`.
The fix adds a SIGKILL escalation test to `paths.test.ts`.

## Recovery path

`fix-ce8db22b` (verifying) → unblocks `mars-1375ab0b` → fast-forward to main.

No additional operator action required.
