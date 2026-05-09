# No-diff acknowledgment: mars-042440db

Task `mars-042440db` ("Mark daemon-restart casualties as 'interrupted'
and retry once…", branch `task/mars-042440db`, signature
`5d9f8e1a2f8ea1a1`) failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

This is yet another no-op against the same oversized 'interrupted'
TaskStatus + daemon-restart retry-once feature prompt previously
documented in `NO-DIFF-mars-209eb596.md`, and re-acknowledged via
`NO-DIFF-mars-00cc790e.md` (recommending a 3-way split). The prompt
asks one `claude -p` session to deliver, in a single dispatch, a
change spanning five loosely-coupled surfaces (TaskStatus union audit,
reconcile rewrite, schema migration + auto-retry, sweeper desync skip,
4 new tests across 8-10 files).

Under `MARS_CLAUDE_MAX_MESSAGES=100`, that shape exceeds one session's
budget — the agent reads, plans, and runs out of message turns before
emitting any edit. Two consecutive no-diff dispatches on
`mars-209eb596` and now another on `mars-042440db` are converging
evidence that this is a **prompt-shape** problem, not a code-level
fix the orchestrator can heal.

## Recommendation

Drop `mars-042440db` and re-enqueue as the same 3-way split previously
recommended in `NO-DIFF-mars-00cc790e.md`:

1. **TaskStatus widening + retry_count migration + cross-file audit.**
   Add `'interrupted'` to the `TaskStatus` union in
   `orchestrator/src/mastra/queue.ts`, add the idempotent
   `retry_count INTEGER NOT NULL DEFAULT 0` ALTER, and reconcile every
   string-literal status check (sweeper sets, worktree-clean,
   reflect-query, daemon/server.ts:253/573/603). No behavior change
   yet — just unblock the type system.

2. **Reconcile rewrite + auto-retry.** Edit
   `orchestrator/src/mastra/daemon/server.ts:738-747` to mark stuck
   running/verifying/merging rows as `'interrupted'`, then transition
   `retry_count=0` rows back to `'queued'` (bumping to 1) and
   `retry_count>=1` rows to `'failed'`. Tests for both paths.

3. **Sweeper desync skip path.** In
   `orchestrator/src/mastra/sweeper/server.ts` around the desync
   self-heal lines, no-op when the task status is `'interrupted'`.
   One test.

Each slice fits comfortably under one `claude -p` budget. Step 1 is
strictly type-only and will compile cleanly on its own; step 2 only
touches reconcile after step 1 lands; step 3 is a single conditional.

## Why no code change in this commit

This worktree is a **fix-fail recovery** dispatch on top of the
original failed feature run. The feature itself produced no diff, so
there is nothing concrete for the recovery dispatch to "fix" — the
correct response is to acknowledge the no-diff with a tracked record
(this file) and let the operator re-shape the work into smaller
slices. Attempting yet another monolithic retry would burn another
no-diff session to the same root cause.

Filed as a paper-trail commit so the failure signature
`5d9f8e1a2f8ea1a1` is visible in `git log` next to its siblings
(`NO-DIFF-mars-209eb596.md`, `NO-DIFF-mars-00cc790e.md`,
`NO-DIFF-mars-883fbafe.md`, `NO-DIFF-mars-74aa7403.md`).
