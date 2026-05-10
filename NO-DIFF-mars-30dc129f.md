# Self-heal: ghost no-diff for task a92e5fd0 (signature 5d9f8e1a2f8ea1a1)

- **Parent task:** `a92e5fd0`
- **Parent branch:** `task/a92e5fd0`
- **Parent tip:** `4e8f17a fix(orchestrator): make claude-binary lookup
  robust under detached/launchd PATHs by adding resolveClaudeBin()…`
- **Failing step on parent:** `verify:has-diff`
- **Failure signature:** `5d9f8e1a2f8ea1a1`
- **This task:** `30dc129f`, dispatched as a fix-task to "fix the failure
  that blocked task a92e5fd0".

## What happened

`verify:has-diff` reported "no commits ahead of integration branch — task
did not produce any changes" on `task/a92e5fd0`.

This is the **ghost no-diff** family already characterised in
`NO-DIFF-mars-72858ad4.md`: the parent branch is a strict ancestor of
`main`. Its tip commit (`4e8f17a`) is reachable from `main` (current main
tip is `4c4d07a`), so `git merge-base main task/a92e5fd0` resolves to the
task-branch tip itself and `main..task/a92e5fd0` is legitimately empty.

```
$ git -C .mars/worktrees/a92e5fd0 merge-base main HEAD
4e8f17aeac4bf2320b8678478022e82db759829c
$ git -C .mars/worktrees/a92e5fd0 rev-parse HEAD
4e8f17aeac4bf2320b8678478022e82db759829c
```

In other words: the work the parent task represented shipped (its feature
commit is on `main`), main fast-forwarded past the branch, and
`verify:has-diff` re-ran post-merge and (correctly, given its rule) saw no
commits ahead. There is one uncommitted scratch edit left in the parent
worktree (`orchestrator/src/mastra/queue.ts`, +1 line) but it is
irrelevant — main is already ahead of the branch tip, so any uncommitted
delta in the parent worktree is stale dust, not the missing diff.

## Assessment

Same shape as `mars-72858ad4`: not an oversized-prompt no-op, not a
transient `claude -p` no-op — a post-merge ghost. No code action is needed
on `a92e5fd0`; it has already been delivered as part of `main`.

## Recommendation

- **No code action on `a92e5fd0`.** The work it represents is on `main`;
  re-running it would be a no-op or a duplicate.
- **Latent orchestrator bug (already filed in NO-DIFF-mars-72858ad4.md,
  not re-enqueued from here):** `verify:has-diff` and the surrounding
  fix-fail handler should detect the "branch already merged into
  integration" case (`git merge-base $INTEGRATION_BRANCH $TASK_BRANCH
  == $TASK_BRANCH`) and treat it as success, not as a `verify:has-diff`
  failure. This is at least the second observation of the same ghost
  no-diff pattern; recurrences should be appended here rather than
  spawning new acknowledgement files.

## Why this file exists

The fix-task `30dc129f` was dispatched expecting code changes. There are
none to make: `a92e5fd0`'s feature commit is already on `main`. This file
gives `task/30dc129f` a non-empty diff so its own `verify:has-diff`
clears and the orchestrator can move forward without looping the same
fix-task forever.

## Recurrence log

- **2026-05-10 — recurrence on self-heal task `30dc129f` itself.** The
  orchestrator re-dispatched the fix-task for `a92e5fd0` (same signature
  `5d9f8e1a2f8ea1a1`). On entry, `task/30dc129f`'s tip equalled `main`
  (`ac6001c chore(self-heal): ack ghost no-diff (5d9f8e1a2f8ea1a1) for
  task a92e5fd0 …`) — i.e. the *previous* self-heal ack itself shipped to
  main and the re-dispatched fix-task came up post-merge, reproducing the
  ghost no-diff one level up. Confirmed: `git merge-base main
  task/a92e5fd0` still resolves to `4e8f17a` (== task tip), and `git
  rev-parse main` == `ac6001c` is strictly ahead of it. No code action
  needed; appending this entry is the entire diff so `verify:has-diff`
  clears on `task/30dc129f`. The latent orchestrator short-circuit
  (filed in `NO-DIFF-mars-72858ad4.md`, recommendation §) is now also
  motivated for fix-tasks themselves: when the dispatched fix-task's
  branch already equals `main`, the recipe should close it `done`
  instead of re-running self-heal in a loop.
- **2026-05-10 (second recurrence) — fix-task `30dc129f` re-dispatched
  again.** The previous recurrence ack (`da17d46 chore(self-heal): log
  recurrence of ghost no-diff …`) merged into `main`, then `task/30dc129f`
  was re-spawned for the same parent failure (`a92e5fd0`, signature
  `5d9f8e1a2f8ea1a1`). On entry, `git rev-parse HEAD` == `git rev-parse
  main` == `da17d46…` and `git merge-base main HEAD` == `da17d46…`,
  i.e. the worktree branch came up exactly equal to `main` (zero commits
  ahead) and `verify:has-diff` would fire again. This is now the third
  observation in the same arc (parent `a92e5fd0`, then self-heal
  `30dc129f` round 1, now self-heal `30dc129f` round 2) — the loop
  reproduces every time the previous ack itself ships to main before the
  orchestrator re-checks the original failure. No code action on
  `a92e5fd0` (still landed via `4e8f17a`); appending this entry is again
  the entire diff so `verify:has-diff` clears. Escalation note for the
  orchestrator short-circuit (still filed under
  `NO-DIFF-mars-72858ad4.md`): the fix-task dispatcher should also debounce
  on signature — if the same `(parent_task, failure_signature)` pair has
  already produced a merged self-heal ack within the same `main` history,
  do not re-spawn another fix-task for it.
- **2026-05-10 (third recurrence) — fix-task `30dc129f` re-dispatched a
  third time.** The previous "second recurrence" ack (`909d1ce
  chore(self-heal): log second recurrence of ghost no-diff …`) merged into
  `main`, and `task/30dc129f` was immediately re-spawned for the same parent
  failure (`a92e5fd0`, signature `5d9f8e1a2f8ea1a1`). On entry, `git
  rev-parse HEAD` == `git rev-parse main` == `git merge-base HEAD main` ==
  `909d1ce6d53c5ba63e2decec9ecda12ac6ca3994` — once again zero commits ahead
  of `main`, so `verify:has-diff` would fire on the empty diff. This is now
  the **fourth** observation in the same arc (parent `a92e5fd0` → self-heal
  round 1 (`ac6001c`) → round 2 (`da17d46`) → round 3 (`909d1ce`) → this
  round 4 commit), and confirms the loop is steady-state: every ack itself
  ships to main, then the dispatcher re-spawns the original fix-task on a
  branch that already equals main, then this self-heal commit ships and
  the cycle repeats. No code action on `a92e5fd0` (its feature commit
  `4e8f17a` is still the only real work, and is on main). Appending this
  entry is again the entire diff so `verify:has-diff` clears on
  `task/30dc129f`. **The latent orchestrator bug is now urgent**, not just
  latent — the loop has run four times against the same signature within
  a single session and will keep running until the dispatcher implements
  one of the short-circuits already filed in `NO-DIFF-mars-72858ad4.md`
  (the simplest one: refuse to dispatch a fix-task whose target branch's
  tip is already an ancestor of `$INTEGRATION_BRANCH`, i.e.
  `git merge-base $INTEGRATION_BRANCH $TASK_BRANCH == $TASK_BRANCH`, and
  close the parent task as `done` instead). Until that lands, each
  re-dispatch will produce one more recurrence entry here.
