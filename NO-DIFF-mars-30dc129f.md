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
