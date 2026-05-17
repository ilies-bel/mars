# Triage: queue-fix-tasks.test.ts:366 stale draft cluster

**Date:** 2026-05-17
**Verdict:** STALE — dismissed. No source change required.

## Claim (recurring across ~8 reflection/planner drafts)

`orchestrator/src/mastra/lib/__tests__/queue-fix-tasks.test.ts` >
`'fails dependent task at unblock time when retry budget already
exhausted'` (line ~366) returns outcome `'queued'` but expects
`'failed'`.

## Why it is stale

The underlying off-by-one was fixed by commit `20b6574`
("Fix retry-budget-exhausted-at-unblock guard to fail spent
dependents"). `blocker-resolution.ts` now uses the shared
`retryBudgetExhausted(retryCount, budget) = retryCount > 0 &&
retryCount >= budget` predicate, so a dependent whose retry budget is
already exhausted at unblock time correctly goes to `failed` with an
inbox item (matching the CLAUDE.md Blockers contract). The drafts are
obsolete artifacts of older worktree bases that predated the fix.

## Verification log (clean main, 2026-05-17)

```
$ cd orchestrator && npx vitest run src/mastra/lib/__tests__/queue-fix-tasks.test.ts

 RUN  v2.1.9 /Users/.../mars-d370f54c/orchestrator

 ✓ src/mastra/lib/__tests__/queue-fix-tasks.test.ts (21 tests) 4186ms

 Test Files  1 passed (1)
      Tests  21 passed (21)
```

0 failed.

## Actions taken

Drafts confirmed via `mars idea show` to carry this exact claim were
dismissed with `mars idea reject` (rationale recorded in each draft's
notes field before rejection):

- `01b00a42-pre-existing-failing-test-src-mastra-lib` → dismissed
- `8df0a773-pre-existing-test-failure-in-orchestrato` → dismissed

Other prefixes from the reported cluster were **not** acted on:

- `b6e62d22`, `56581f3b`, `6225c017`, `d36e3956`, `effd085c` — not
  found (already gone).
- `e67663e4-pre-existing-failing-test-orchestrator-s` — **deliberately
  left open.** It has been reshaped from the stale test claim into a
  legitimate duplicate-detection feature PRD ("Warn the operator before
  a near-duplicate task is added, and silently collapse duplicate
  agent-filed drafts"), with a wired idea→idea dependency on
  `2be831da`. The cluster is cited there only as motivating evidence,
  not as work to do. Rejecting it would destroy live PRD work.
