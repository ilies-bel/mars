# Rescue assessment — arc 52f0a49a-re-enable-live-execution-so-a-foreground

**Date:** 2026-08-18  
**Rescue task:** mars-f46d9d78  
**Dead-ended task:** mars-b0bf1083 (failure_signature: merge:zero-commit-branch/unclassified)  
**Recovery task:** fix-f0f05dd7 (same signature — arc exhausted its retry budget)

## What happened

`mars-b0bf1083` was Slice 1 of 11 for PRD `52f0a49a`: implement a
`composeLiveBriefing(taskId): Promise<string>` function in
`orchestrator/src/core/lib/live-briefing.ts` that assembles the operator-
facing briefing for a parked task.

The merge gate rejected the task branch with `merge:zero-commit-branch`
because the branch had **0 commits ahead of main** by the time the merge
step ran. The recovery task `fix-f0f05dd7` was dispatched but also found
no commits to land — the arc dead-ended.

**Root cause:** the implementation did land on main, just through a
different merge window. Commit `316006af feat(live-briefing): add
composeLiveBriefing function` is present on `main`:

```
$ git log --oneline main | grep live-briefing
316006af feat(live-briefing): add composeLiveBriefing function
```

The function exists in `orchestrator/src/core/lib/live-briefing.ts` and
satisfies the acceptance criteria:

- Exports `composeLiveBriefing(taskId): Promise<string>` ✓  
- Returns sections in order: Task, Done criteria, Step guide, Progress journal ✓  
- Throws `LiveBriefingError` when the task is not `awaiting-human` ✓

## Action taken: **supersede**

The task's work is already on `main`. There is nothing to restart or
continue. Both `mars-b0bf1083` and its recovery `fix-f0f05dd7` can be
superseded; downstream slices blocked on them are unblocked once the
operator marks the origin settled.

## Verification

```
git log --oneline main | grep live-briefing
316006af feat(live-briefing): add composeLiveBriefing function

git -C .mars/worktrees/mars-b0bf1083 rev-list --count main..HEAD
0

cd orchestrator && npm run knip   → exit 0 (no new unused exports)
```
