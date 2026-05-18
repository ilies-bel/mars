# Context-gather result: mars-f3594e3d → mars-9b364692

## Status: ALREADY ON MAIN — no action needed

The failing test `'fails dependent task at unblock time when retry budget already exhausted'`
(queue-fix-tasks.test.ts:450) is **green on main** as of commit `20b6574`.

## What the fix is

`orchestrator/src/mastra/blocker-resolution.ts` now has a shared predicate:

```typescript
const retryBudgetExhausted = (retryCount: number, budget: number): boolean =>
  retryCount > 0 && retryCount >= budget
```

This replaced the duplicated `retryCount > budget` inline guard in both
`onBlockerTaskCompleted` and `recoverBlockedTasks`. With `>`, a dependent
with `retryCount=1, budget=1` satisfied `1 > 1 == false` and fell through
to `queued` instead of `failed`. The compound predicate (`retryCount > 0 &&
retryCount >= budget`) correctly handles all three cases:

| retryCount | budget | result   | why                                 |
|------------|--------|----------|-------------------------------------|
| 0          | 0      | queued   | fresh dependent, `> 0` clause saves |
| 1          | 0      | failed   | burned budget=0, `> 0 && >= 0`      |
| 1          | 1      | failed   | exhausted budget=1, `> 0 && >= 1`   |

A subsequent commit `bfe59a2` also flipped the gate inside
`handleTaskFailureWithFixTask` (`>=` → `>`) to preserve the
"first failure always gets a fix task" behaviour.

## All 24 tests pass on main

```
✓ src/mastra/lib/__tests__/queue-fix-tasks.test.ts (24 tests)
  ✓ fails dependent task at unblock time when retry budget already exhausted
```

The mars-f3594e3d and mars-9b364692 worktrees can be closed without
further action.
