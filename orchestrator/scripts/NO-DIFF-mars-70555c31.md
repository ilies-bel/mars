# No-diff acknowledgment: mars-70555c31

Task `mars-70555c31` ("Fix sweeper dedup so identical verify:has-diff
tasks aren't re-enqueued", branch `task/mars-70555c31`, signature
`5d9f8e1a2f8ea1a1`) failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

The task is already `dropped` with
`dropReason: retry_budget_exhausted:5d9f8e1a2f8ea1a1` and
`retryCount: 1` — i.e. the per-signature retry budget in
`orchestrator/src/mastra/queue-fix-tasks.ts:208` did its job and
stopped further self-heal dispatches for this signature. There is no
upstream code-level fix this recovery dispatch can apply.

## Why no code change in this commit

This is the second-order failure: the *original* feature run
mars-70555c31 produced no diff (verify:has-diff tripped), and this
fix-fail recovery worktree was dispatched on top of it. Because the
feature itself never wrote any code, there is nothing for the recovery
to "fix" — only the prompt shape to acknowledge.

Inspection confirms that none of the acceptance criteria from the
original prompt landed:

- No `self_heal_attempts` table (no migration in `queue.ts`).
- No `orchestrator/src/mastra/lib/retry-budget.ts` module.
- No dedup query inside `orchestrator/src/mastra/sweeper/server.ts`
  (`grep retry_budget|self_heal_attempts` is empty there).
- The retry-budget check that *did* drop this very task lives only in
  `queue-fix-tasks.ts:208` and uses an inline budget — it predates
  this task and is what closed the cost leak in practice, not the
  proposed table.

## Why the prompt did not produce a diff

The prompt asks one `claude -p` session to deliver, in a single
dispatch, a change spanning five loosely-coupled surfaces:

1. New `self_heal_attempts` table + migration in
   `orchestrator/src/mastra/queue.ts`.
2. Insert-attempt-row write in
   `orchestrator/src/mastra/queue-fix-tasks.ts`.
3. Dedup-on-in-flight query in
   `orchestrator/src/mastra/sweeper/server.ts:247-263`.
4. New module `orchestrator/src/mastra/lib/retry-budget.ts` (signature
   → budget map + `getBudget()` helper).
5. Three new test cases in
   `orchestrator/src/mastra/lib/__tests__/queue-fix-tasks.test.ts`
   (no-prior, in-flight, budget-exhausted).

Under `MARS_CLAUDE_MAX_MESSAGES=100`, that surface area exceeds one
session's message budget — the agent reads, plans, designs the
migration, and runs out of turns before emitting any edit. This
matches the converging signature `5d9f8e1a2f8ea1a1` pattern
documented in `NO-DIFF-mars-042440db.md`,
`NO-DIFF-mars-209eb596.md`, `NO-DIFF-mars-00cc790e.md`,
`NO-DIFF-mars-883fbafe.md`, and `NO-DIFF-mars-74aa7403.md`. It is a
**prompt-shape** problem, not a code-level fix.

## Recommendation

Drop `mars-70555c31` (already dropped) and re-enqueue as a 3-way
split, each slice fitting comfortably under one `claude -p` budget:

1. **Schema + insert.** Add the `self_heal_attempts` table migration
   in `orchestrator/src/mastra/queue.ts` (CREATE TABLE +
   composite index on `(parent_task_id, failure_signature)`). Wire
   `queue-fix-tasks.ts` to INSERT a row each time it successfully
   enqueues a fix-task. No reads yet — schema-only landing so the
   table is populated for downstream consumers.

2. **Retry-budget module + sweeper dedup.** Add
   `orchestrator/src/mastra/lib/retry-budget.ts` exporting a tiny
   `Readonly<Record<string, number>>` (default 1, `'daemon-killed'`
   = 3) and a `getBudget(signature)` helper. In
   `orchestrator/src/mastra/sweeper/server.ts:247-263`, before
   enqueuing the fix-task, query `self_heal_attempts` for the
   failure_signature: skip if any in-flight row exists, or if the
   per-`(parent, signature)` count has reached the budget.

3. **Tests.** Add the three cases in
   `orchestrator/src/mastra/lib/__tests__/queue-fix-tasks.test.ts`:
   no prior attempt → enqueues + inserts; in-flight row for same
   signature → no enqueue; budget exhausted → no enqueue, parent
   stays `'blocked'`.

Each slice is independently verifiable (`npm run typecheck` and
`npm test` from `orchestrator/`) and lands in `main` without
depending on a later slice for correctness.

Filed as a paper-trail commit so the failure signature
`5d9f8e1a2f8ea1a1` is visible in `git log` next to its siblings
(`NO-DIFF-mars-042440db.md`, `NO-DIFF-mars-209eb596.md`,
`NO-DIFF-mars-00cc790e.md`, `NO-DIFF-mars-883fbafe.md`,
`NO-DIFF-mars-74aa7403.md`, `NO-DIFF-mars-38636665.md`).
