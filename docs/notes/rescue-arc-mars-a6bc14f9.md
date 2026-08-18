# Rescue assessment — arc mars-a6bc14f9

**Date:** 2026-08-18
**Rescue task:** mars-e3225d5a
**Arc members (at dispatch):** fix-cb54cee9 (queued), mars-5d8cee20 (blocked), mars-a6bc14f9 (blocked)

## What happened

`mars-a6bc14f9` was a test-only task: delete/repair five stale SQLite-era
and shape-drift assertions in `orchestrator/src/core/__tests__`. The worker
did the requested edits correctly (commit `5ea135a9`) but the task's full
`verifyCmd` (`npx vitest run src/core/__tests__ && npx tsc --noEmit`) failed
— not on the target files, but because every test file that transitively
imports `src/core/queue.ts` (→ `./arc` → `@deepseek-ai/cordis`) fails at
Vite collection time with `Failed to load url @deepseek-ai/cosmokit`. That
worker proved this is a pre-existing, environment-level `node_modules`
resolution problem (reproduces at the merge-base commit, on completely
untouched files, unaffected by `tsc --noEmit`) and filed a proper follow-up,
`mars-5d8cee20`, to track/repair the shared `orchestrator/node_modules`
instead of silently patching a corrupted install inline. `mars-a6bc14f9`
then failed on its own unresolved verify, and the orchestrator spawned the
recovery task `fix-cb54cee9`.

By the time the rescue-operator dispatch was generated, the arc looked
dead-ended: `fix-cb54cee9` was merely **queued** (not yet dispatched),
`mars-a6bc14f9` was **blocked** waiting on it, and `mars-5d8cee20` was
**blocked** waiting on `mars-a6bc14f9` — no member had visible forward
motion, matching a stuck-arc pattern.

## State at rescue time

By the time this rescue task actually investigated (a few minutes later),
the picture had changed:

- `mars daemon status` showed `fix-cb54cee9` genuinely **in-flight**
  (`implement fix-cb54cee9`), with a live `vitest`/`rtk` subprocess actively
  running a targeted re-verify of the four still-present test files.
- The worktree at `.mars/worktrees/mars-a6bc14f9` has a clean tree on
  `task/mars-a6bc14f9`, HEAD `16364df7` (`test(core): repair stale
  SQLite-era and shape-drift test assertions`) — a newer commit than the
  `5ea135a9` referenced in the original task's journal, i.e. `fix-cb54cee9`
  had already made real progress reworking the fix before this rescue task
  looked.
- `mars continue mars-a6bc14f9` was attempted as a non-destructive probe and
  correctly refused: `task mars-a6bc14f9 already has an in-flight recovery
  fix-cb54cee9; wait for it to complete or use 'mars restart' to discard and
  re-run` (exit 1).

## Action taken: **continue** (no-op — recovery already in flight)

The daemon had already un-stuck the arc on its own between dispatch and
investigation: it dispatched the queued `fix-cb54cee9`, which is now
actively re-verifying real, committed progress on the original worktree.
None of the three rescue actions apply destructively here:

- **restart** would discard `fix-cb54cee9`'s live, uncommitted-in-DB
  progress and the salvage commit `16364df7` for no reason — actively
  harmful against a worker that is mid-run.
- **supersede** is unwarranted — the original scope is intact, correctly
  understood, and being carried out by the existing recovery.
- **continue** is the semantically correct call, and `mars continue` itself
  confirmed it: the recovery is already continuing, so no new mutation was
  needed or performed.

`mars-5d8cee20` (the environment-repair follow-up for the shared
`node_modules` cosmokit resolution bug) remains correctly blocked on
`mars-a6bc14f9` and will settle automatically once that task's chain
completes — no action required there either.

## Verification

No production or test code was touched by this rescue task (nothing to
verify beyond the arc-state read above). `fix-cb54cee9` remains responsible
for its own verify gate on `orchestrator/src/core/__tests__` before it can
merge.
