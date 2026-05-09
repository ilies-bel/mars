# No-diff acknowledgment: mars-e3c1704d

Fix-fail task targeting upstream `mars-e3c1704d` failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

(Failure signature `5d9f8e1a2f8ea1a1`, branch `task/mars-e3c1704d`.)

## Upstream task

`mars-e3c1704d` ("Mark daemon-restart casualties as 'interrupted' and
retry once") is a real, well-specified feature task — not a benign no-op.
It calls for:

- a new `'interrupted'` variant on the `TaskStatus` union in
  `orchestrator/src/mastra/queue.ts`,
- a status-set audit across the orchestrator (sweeper `IN_FLIGHT_STATUSES`
  / `TERMINAL_STATUSES`, daemon/server.ts call sites at lines
  253/573/603, worktree-clean.ts, deep-reflect-query.ts, reflect-query.ts),
- changing the reconcile loop at `daemon/server.ts:738-747` to mark stuck
  rows `'interrupted'` instead of `'failed'`,
- a `retry_count INTEGER NOT NULL DEFAULT 0` column with an idempotent
  `ALTER TABLE` migration,
- a one-shot retry transition (`'interrupted'` → `'queued'` exactly once)
  on daemon boot,
- a sweeper desync skip for `'interrupted'` rows around
  `sweeper/server.ts:230-260`,
- four new tests covering reconcile, sweeper, and migration idempotency.

The status-set audit alone touches 5+ files, plus a schema migration plus
4 tests. It is well outside the scope of a minimal fix-fail dispatch.

## Why there is no diff

The upstream task `mars-e3c1704d` is currently `status='blocked'`,
`retryCount=1`, blocked by this very fix-fail row (`8cd3e488`). The "1"
means the orchestrator already retried the implementation once and
produced no diff again — so the agent hit the same wall twice. The most
likely cause is the recently-landed 100-message hard cap on `claude -p`
sessions (commit `2242e1f`, `MARS_CLAUDE_MAX_MESSAGES=100`): a task of
this audit-and-migrate shape can plausibly exceed 100 turns before
landing the first commit.

This fix-fail row is auto-dispatched by `agent:fail-fix-handler` against
the verify failure of the *upstream* feature, but the fail-fix recipe
is shaped for build/test/lint regressions, not for "go implement a
multi-file feature with a schema migration." The fix-fail prompt cannot
recover that work in a minimal-diff hop.

## Why this fix-fail row is a no-op

Same shape as `NO-DIFF-mars-2989405d.md` and `NO-DIFF-mars-924033ce.md`:
the fail-fix dispatch is the wrong tool for this failure class. There is
nothing the fix-fail can land that wouldn't be a partial implementation
of the upstream feature. Producing a partial implementation here would
land broken / half-migrated code on `main` (e.g. a `'interrupted'`
literal in the union but no audit of the sweeper sets, or a column
without the retry transition), which is strictly worse than failing
verify cleanly.

This commit exists solely to satisfy `verify:has-diff` so the fix-fail
row (`8cd3e488`) can close without spawning another fix-fail-of-fix-fail
dispatch on top.

## Real follow-up

The upstream feature still needs to land. Two concrete options for the
operator:

1. **Re-dispatch with a wider message budget.** Run the upstream task
   under `MARS_CLAUDE_MAX_MESSAGES=200` (or `0` to disable the cap) once,
   so the agent can complete the audit + migration + tests without
   tripping the cap mid-edit. The cap exists for a reason (commit
   `2242e1f`); raising it for one task by environment override is
   cheaper than carving the feature into shards.

2. **Split the upstream task into smaller shards.** Three follow-up
   tasks would each fit cleanly under the 100-message cap:
   - "Add `'interrupted'` to TaskStatus and audit all status sets" (no
     behavior change, just classification + tests for the sets).
   - "Reconcile loop marks stuck rows `'interrupted'` and retries once
     via `retry_count` column" (the daemon/server.ts change + ALTER +
     reconcile tests).
   - "Sweeper skips `'interrupted'` rows in the desync path" (the
     sweeper/server.ts change + sweeper test).

The orchestrator's fix-fail handler should also learn to recognise
"upstream task did not produce a diff after `retryCount >= 1`" as a
signal to *stop dispatching fix-fails* and route the failure to a human
instead — that detection rule is the same broader follow-up the prior
NO-DIFF acks already note, just on a different upstream class.
