# Rescue assessment — arc mars-7d0094a2 (worktree-emptied-during-recovery)

**Date:** 2026-08-17
**Rescue task:** mars-9a9e42e4 (cancelled by orchestrator: `origin succeeded; in-flight recovery cancelled`)
**Recovery of rescue task:** fix-db1f9593 (this task)
**Failed task:** mars-7d0094a2 (guard sweepers against removing an active worktree)
**Recovery task:** fix-f97643a6 (done — first-principles recovery completed the work)

## What happened

`mars-7d0094a2` reported that during a prior task, the worktree checkout was
externally emptied twice while work was actively happening in it —
`git worktree list` marked it prunable and the directory contents were gone.
Suspicion pointed at one of Mars's own worktree sweepers running too
aggressively against a still-live worktree.

The task appears to have hit a phantom `unknown/timed-out` failure while its
recovery `fix-f97643a6` completed the work from first principles. The
orchestrator then spawned rescue-operator `mars-9a9e42e4` to triage the
dead-ended arc, but by then `fix-f97643a6` had already succeeded and the
origin `mars-7d0094a2` had reached `done` — so the blocker-resolution
subscriber cancelled the in-flight rescue-operator (`failure_reason_code:
origin-succeeded-cancel`, per `orchestrator/src/core/daemon/server.ts:5866`)
and the fix-task `fix-db1f9593` was spawned as its recovery.

## State at rescue time

The work is on `main`:

```
1986a53a fix(worktree): guard sweeper against removing active worktrees
```

`worktreeRemovalGuard(wtPath, nowMs?)` was added to
`orchestrator/src/core/lib/worktree-clean.ts` and wired into both
`runWorktreeClean` and `runWorktreePrune`. A blocked deletion is logged via
both the runner's `log` callback and `console.error`, and a `keptByGuard`
counter was added to `RunSummary` / `PruneRunSummary`. The new
`worktree-removal-guard.test.ts` suite exercises the guard against the real
`git` binary (mtime block, dirty-file block, staged-file block, clean-repo
pass, committed-then-clean pass, missing-path pass).

The three implicit goals of the original bug report are met on `main`:

1. ✅ Active worktrees (recent mtime) are guarded from sweeper deletion.
2. ✅ Worktrees with uncommitted changes are guarded from sweeper deletion.
3. ✅ Guard refusals log loudly to stderr for auditability.

## Arc status

| Task | Status | Notes |
|---|---|---|
| mars-7d0094a2 | done | Work merged as `1986a53a` |
| fix-f97643a6 | done | First-principles recovery finished the work |
| mars-9a9e42e4 | blocked | Rescue-operator; cancelled — arc self-resolved |
| fix-db1f9593 | running | This recovery — trivially resolved |

## Verdict

**supersede** — the arc is fully resolved. The rescue-operator's question
("what should we do with this dead-ended arc?") was answered on its own by
`fix-f97643a6` before `mars-9a9e42e4` could act. No restart, continue, or
additional code change is required. This recovery task exists purely as
bookkeeping so the orchestrator can settle the blocker chain.

```json
{"action":"supersede","reasoning":"origin done — fix-f97643a6 completed the work (1986a53a on main) before the rescue-operator could act"}
```

## knip check

`npm run knip` exits 0 (invoked with `--no-exit-code`). Existing unused-export
findings are tracked separately in `orchestrator/KNIP-CLEANUP-PLAN.md` (Slice 1,
still open) and are out of scope for this recovery.
