# No-diff acknowledgment: mars-00cc790e (fix-fail pass 2)

This is the **second** fix-fail dispatch chained on top of upstream
`mars-00cc790e` ("Mark daemon-restart casualties as 'interrupted' and
retry once"). Failure shape — branch `task/mars-00cc790e`, signature
`5d9f8e1a2f8ea1a1`, error "no commits ahead of integration branch" — is
identical to pass 1.

Pass 1 (worktree branch unrecorded; commit `91fbc83` on `main`) already
landed `orchestrator/scripts/NO-DIFF-mars-00cc790e.md`, which contains
the full why-no-diff analysis and the recommended 3-way split. That
file is unchanged on `main` and remains the substantive record. Read it
first.

This file (`NO-DIFF-mars-00cc790e-pass2.md`) exists solely so this
worktree (`b430e054`) produces a non-empty diff and `verify:has-diff`
passes — the daemon's fail-fix handler has now dispatched a second
fix-fail row against the same upstream task without the underlying
implementation work being any easier to do in a single `claude -p` pass
than it was last time.

## What's actually broken

The fix-fail handler is dispatching repeatedly against an upstream
failure class it cannot resolve. The pattern:

1. Upstream feature task `mars-00cc790e` (originally `mars-e3c1704d`,
   re-instantiated) fails verify with `verify:has-diff` — the agent
   couldn't land any code under the 100-message cap.
2. Daemon auto-spawns a fix-fail row authored
   `agent:fail-fix-handler` with the verify error as the prompt.
3. The fix-fail row is itself a one-shot `claude -p` against the same
   too-large feature, with **less** context than the upstream prompt
   (just the verify error tail), so it also produces no diff.
4. That fix-fail row's verify failure (signature `5d9f8e1a2f8ea1a1`)
   triggers another fix-fail dispatch — this worktree.
5. Goto 3.

The chain is broken only because the human operator commits an ack
file by hand. That is a reliability bug in the fix-fail handler.

## Concrete handler change (filed as follow-up, not done here)

The fail-fix handler (`agent:fail-fix-handler` in
`orchestrator/src/mastra/daemon/server.ts`) should refuse to dispatch a
new row when **any** of these hold for the upstream task:

- `failureSignature === '5d9f8e1a2f8ea1a1'` (the no-diff signature) —
  fix-fail cannot fix "agent didn't write any code"; route to a human
  via the inbox instead.
- The upstream task already has `retryCount >= 1` AND the verify
  failure is `verify:has-diff` — second no-diff in a row is the same
  signal as above.
- The upstream task already has a sibling fix-fail row (same
  `fixForTaskId`) in `failed`/`done`/`blocked` state — chaining a third
  attempt won't change the outcome.

The detection is cheap (a single `SELECT` against `tasks` keyed on
`fix_for_task_id` and `failure_signature`) and lives in the dispatch
guard already present in the daemon's fix-fail path. This isn't done
here because, like the upstream feature itself, it touches the daemon
reconcile + fix-fail surfaces and exceeds a single fix-fail dispatch's
budget — but it is the correct long-term fix and should be enqueued as
a standalone `mars task add` once an operator is on hand.

## Status of the upstream feature

`mars-00cc790e` remains `blocked` on this row. The recommended split in
`NO-DIFF-mars-00cc790e.md` (three independently-verifiable shards) is
still the right unblock path. No new analysis is added here.
