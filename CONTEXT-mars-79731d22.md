# Context note — mars-79731d22 (context-gather for mars-aace6bd3)

## Summary

The implementation described in the original mars-82067221 task (reconcile-loop
worktree cleanup on daemon restart) is **already on main**. This entire
context-gathering chain can be closed.

## What is already implemented

### `orchestrator/src/mastra/daemon/reconcile-running.ts`
Landed via `ccd1266 fix: requeue running tasks on daemon restart instead of hard-failing them`.

For every `running` task on daemon restart:
1. Removes the worktree directory from disk via `removeWorktree(...)` (best-effort).
2. Deletes the git branch (best-effort, `git branch -D`).
3. Resets the task row to `queued` with all in-flight fields cleared.
4. Does NOT increment `retryCount` — a restart is not a task fault.

### `orchestrator/src/mastra/daemon/server.ts` reconcile (lines 1043–1180)
For `verifying` tasks (landed via `753e4ef fix(reconcile): prune stale git worktree registrations`):
- Worktree exists → requeue at verify step.
- Worktree missing → prune stale git registration (`removeWorktree(..., keepBranch=true)`) then mark failed.

For `merging` tasks:
- FF landed → cleanup worktree, mark done.
- FF not landed → cleanup worktree + delete branch, requeue from setup.

### `orchestrator/src/mastra/daemon/__tests__/reconcile-running.test.ts`
6 passing tests, including one that creates a real registered git worktree and
asserts it is gone from disk after `requeueRunningTasksFromPriorDaemon`. This
satisfies the unit-test requirement in the original prompt.

## Verification

```
cd orchestrator && npm run build   # passes
npx vitest run src/mastra/daemon/__tests__/reconcile-running.test.ts  # 6/6 pass
```

## Action

No code changes needed. Commit this note and close the chain.
