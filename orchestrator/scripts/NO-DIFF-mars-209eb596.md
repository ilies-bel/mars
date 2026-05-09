# No-diff acknowledgment: mars-209eb596

Task `mars-209eb596` ("Mark daemon-restart casualties as 'interrupted'
and retry once…", branch `task/mars-209eb596`) failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

This is the original feature task itself, dispatched once and retried
once (`retryCount: 1`), and both passes ended with the agent producing
no commit. The fix-fail dispatch on top of it is the commit you are
currently reading (branch `task/904bf8c1`, blockedBy `mars-209eb596`).

This is the same shape of failure documented in
`NO-DIFF-mars-883fbafe.md` (oversized feature task), not the fix-fail
recovery flavor seen in `NO-DIFF-mars-e3c1704d.md` /
`NO-DIFF-mars-2989405d.md`.

## Why there is no diff

The acceptance criteria describe a real, implementable change — the
"daemon restart while task was running" string at
`orchestrator/src/mastra/daemon/server.ts:738-747` is a concrete entry
point, and the proposed `interrupted` semantics are well-defined. The
problem is **shape**, not feasibility: the prompt asks one `claude -p`
session to deliver, in a single dispatch, a change that spans five
loosely-coupled surfaces:

1. **`TaskStatus` union edit + audit.** Add `'interrupted'` to the
   union at `orchestrator/src/mastra/queue.ts:6-16`, then visit every
   string-literal status check across the orchestrator and classify the
   new variant explicitly. The prompt itself enumerates at least six
   call sites that must be audited:
   `worktree-clean.ts:76`, `deep-reflect-query.ts:79`,
   `reflect-query.ts:184`, and `daemon/server.ts:253/573/603`, plus the
   sweeper's `IN_FLIGHT_STATUSES` (line 103) and `TERMINAL_STATUSES`
   (line 110) sets. Each site needs a deliberate decision (not in-flight,
   not terminal, not failed, not done) — that is taxonomy work, not a
   mechanical replace.
2. **Reconcile loop rewrite.** Change the body of the
   `running/verifying/merging` reconcile pass at
   `daemon/server.ts:738-747` to mark stuck rows as `interrupted` with
   the original error string preserved verbatim, and update the log
   line.
3. **Schema migration + auto-retry.** Add a new
   `retry_count INTEGER NOT NULL DEFAULT 0` column to the `tasks` table
   via an idempotent `ALTER TABLE` wrapped in a duplicate-column
   try/catch, then add the retry logic on daemon boot: if `retry_count`
   = 0, bump to 1 and flip status back to `queued` (in place — not via
   `task add`) and re-emit `bus.emit('task.queued', { taskId })`; if
   `retry_count` >= 1, set status `failed` and preserve the original
   error.
4. **Sweeper desync skip path.** In
   `orchestrator/src/mastra/sweeper/server.ts` (around lines 230-260),
   when a worktree branch on disk maps to an `interrupted` task, log
   `[sweeper] task <id> interrupted; awaiting retry` and skip the
   self-heal enqueue.
5. **Four new tests.** Reconcile with `running` + `retry_count=0`,
   reconcile with `interrupted` + `retry_count=1`, sweeper-skip on
   `interrupted`, and idempotent-`ALTER TABLE` (run-twice) coverage.
   These need a daemon-reconcile fixture (the prompt notes one may
   already live under `daemon/__tests__/` but does not confirm it).

That is a TaskStatus union change with cross-cutting audits, two
runtime behavior changes (reconcile + sweeper), one DB schema migration
with an idempotency contract, and a test fixture build-out — well above
the working budget of one headless dispatch under the new
`MARS_CLAUDE_MAX_MESSAGES=100` cap (commit `2242e1f`). Two consecutive
no-diff results from the same oversized prompt is the failure mode that
shape — not the recipe — needs to fix.

## Why this fix-fail task is itself a no-op (in code)

Splitting `mars-209eb596` into smaller independently shippable Mars
tasks is a **planning** action — it belongs in the `mars task add`
queue, not in this worktree's diff. The block-tracked-writes hook also
forbids touching `CONTEXT.md` / `docs/adr/**` directly from a coding
worktree, so the only correct on-disk artifact for this fix-fail row is
this acknowledgment.

The four follow-up tasks below are the recommended split. They are not
enqueued by this commit; the daemon ack flow will surface this row to
the human operator, who can decide whether to enqueue them as written
or re-shape further before adding them via `mars task add`.

## Recommended split

Slice the original spec into four ordered tasks. Each is small enough
to fit one `claude -p` dispatch and verifies independently.

1. **TaskStatus: add `'interrupted'` variant + audit call sites.** In
   `orchestrator/src/mastra/queue.ts`, extend the `TaskStatus` union
   with `'interrupted'` and visit every string-literal status check
   across the orchestrator. For each site, decide explicitly whether
   `interrupted` belongs:
   - sweeper `IN_FLIGHT_STATUSES` / `TERMINAL_STATUSES` sets — it
     belongs to neither;
   - `worktree-clean.ts:76`, `deep-reflect-query.ts:79`,
     `reflect-query.ts:184`, `daemon/server.ts:253/573/603` — case
     by case.
   No reconcile-loop change yet; no schema change yet. Verify with
   `npm run build` (catches missing branches in exhaustive switches)
   plus the existing test suite.

2. **Reconcile loop: mark stuck rows as `interrupted` instead of
   `failed`.** Build on (1). Change the body of the loop at
   `daemon/server.ts:738-747` so `running`/`verifying`/`merging`
   survivors become `status='interrupted'` with the
   `daemon restart while task was <status>` error string preserved
   verbatim. Update the log line. No retry logic yet; no schema change
   yet. Verify with a new test under `daemon/__tests__/` that asserts
   the post-reconcile status and error.

3. **Schema migration + one-shot auto-retry on daemon boot.** Build
   on (2). Add the `retry_count INTEGER NOT NULL DEFAULT 0` column to
   the `tasks` table via an idempotent `ALTER TABLE` wrapped in a
   duplicate-column try/catch. In the same reconcile pass, after the
   stuck-rows loop, transition each `interrupted` row exactly once: if
   `retry_count = 0`, bump to 1, set status `queued`, clear error, and
   `bus.emit('task.queued', { taskId })`; if `retry_count >= 1`, set
   status `failed`, preserve the original error, and log
   `[reconcile] task <id> was interrupted twice; giving up`. Mutate
   the existing row in place — do **not** call `task add`. Verify
   with two new tests (retry_count=0 → queued; retry_count=1 → failed)
   plus an idempotent-ALTER run-twice test.

4. **Sweeper desync: skip self-heal enqueue for `interrupted`
   tasks.** Build on (3). In
   `orchestrator/src/mastra/sweeper/server.ts` (around lines 230-260),
   when the desync path observes a worktree branch on disk for a task
   whose status is `interrupted`, log
   `[sweeper] task <id> interrupted; awaiting retry` and skip the
   self-heal enqueue. The retry triggered in (3) will reuse the
   worktree (or rebuild it). Verify with a new sweeper test that
   asserts no self-heal enqueue under `interrupted`.

Each follow-up task should reference this ack file in its prompt body
so the next agent has the context for *why* the original was split.
The reconcile-loop entry point (`daemon/server.ts:738-747`) and the
sweeper status-set lines (`sweeper/server.ts:103` /
`sweeper/server.ts:110`) are the authoritative anchors for tasks (2),
(3), and (4); they are stable across the recent commits surveyed in
this worktree.

## Real follow-up

Same pattern as `NO-DIFF-mars-883fbafe.md`:

- **Oversized-prompt detection at planning time.** A task whose
  acceptance bullets cross more than ~3 subsystems (here: queue
  taxonomy, daemon reconcile, DB schema, sweeper, plus a test fixture)
  should be flagged at `mars task add` time, not after two failed
  dispatches. The `/mars:next` shaping flow could enforce this as a
  heuristic on the technical-notes section.
- **Two-strikes drop-and-reshape.** After two consecutive
  `verify:has-diff` no-diff failures on the same prompt with the same
  retryCount delta, the daemon should auto-route to a "re-shape" inbox
  item rather than a third dispatch.

Both follow-ups are out of scope for this acknowledgment commit and
should be filed as separate `mars task add` entries by the human
operator who reads this row. They are the same two follow-ups already
proposed in `NO-DIFF-mars-883fbafe.md`; a second NO-DIFF row on a
different oversized feature task is corroborating evidence that the
planner-side rule is worth the round-trip cost.
