# No-diff acknowledgment: mars-2070f4f2

Task `mars-2070f4f2` ("Guard daemon-restart task failures: checkpoint
before billing", branch `task/mars-2070f4f2`, signature
`5d9f8e1a2f8ea1a1`) failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

This is the latest recurrence of the same oversized daemon-restart
retry feature documented in `NO-DIFF-mars-209eb596.md`,
`NO-DIFF-mars-00cc790e.md`, `NO-DIFF-mars-00cc790e-pass2.md`, and
`NO-DIFF-mars-042440db.md`. The prompt asks one `claude -p` session
to deliver, in a single dispatch:

- two new columns on the `tasks` table (`error_kind`, `interrupt_retry_count`)
  via the in-place migration pattern at `queue.ts:122-130`,
- corresponding extensions to the Task row shape and every INSERT/UPDATE
  statement in `queue.ts`,
- a reconcile rewrite at `daemon/server.ts:736-747` that flips stuck
  rows to `failed`+`interrupted` and re-enqueues them at
  `priority=MAX_PRIORITY` while incrementing the retry counter,
- a hard cap at 3 retries with the row staying `failed` afterwards,
- and three verification steps including a manual SIGTERM-and-restart
  loop.

Under `MARS_CLAUDE_MAX_MESSAGES=100`, that shape exceeds one session's
budget — the agent reads, plans, and runs out of message turns before
emitting any edit. Five consecutive no-diff dispatches against this
prompt shape (`mars-209eb596`, `mars-00cc790e` ×2, `mars-042440db`,
now `mars-2070f4f2`) are conclusive evidence that this is a
**prompt-shape** problem, not a code-level fix the orchestrator can
heal.

Note: `mars-2070f4f2` is already marked `dropped` in `.mars/queue.db`,
so no further action is needed against the row itself; this file is
the paper-trail commit so the failure signature `5d9f8e1a2f8ea1a1`
remains visible in `git log` next to its siblings.

## Recommendation

Re-enqueue as the same 3-way split previously recommended in
`NO-DIFF-mars-00cc790e.md` and `NO-DIFF-mars-042440db.md`:

1. **Schema widening only.** Add the two columns
   (`error_kind TEXT NULL`, `interrupt_retry_count INTEGER NOT NULL DEFAULT 0`)
   via the in-place migration pattern at `queue.ts:122-130`, extend
   the Task row shape and every INSERT/UPDATE statement, and audit
   every status string-literal check (sweeper sets, worktree-clean,
   reflect-query, daemon/server.ts:253/573/603). No behavior change
   yet — just unblock the type system.

2. **Reconcile rewrite + auto-retry.** Edit
   `daemon/server.ts:736-747` to set `error_kind='interrupted'` on the
   failed flip, then re-enqueue rows with
   `interrupt_retry_count < 3` at `priority=MAX_PRIORITY` with a
   bumped counter. Tests for the retry-cap and priority-respect
   paths.

3. **Sweeper desync skip path.** In
   `orchestrator/src/mastra/sweeper/server.ts` around the desync
   self-heal lines, no-op when the row is already
   `failed`+`interrupted`. One test.

Each slice fits comfortably under one `claude -p` budget. Step 1 is
strictly type-only and will compile cleanly on its own; step 2 only
touches reconcile after step 1 lands; step 3 is a single conditional.

After five paper-trail-only acknowledgments at this signature, the
fix-fail handler should stop dispatching another monolithic retry
against this prompt shape and route signature `5d9f8e1a2f8ea1a1`
straight to the human inbox instead.

## Why no code change in this commit

This worktree is a **fix-fail recovery** dispatch on top of the
original failed feature run. The feature itself produced no diff, so
there is nothing concrete for the recovery dispatch to "fix" — the
correct response is to acknowledge the no-diff with a tracked record
(this file) and let the operator re-shape the work into smaller
slices. Attempting yet another monolithic retry would burn another
no-diff session to the same root cause.
