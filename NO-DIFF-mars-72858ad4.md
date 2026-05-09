# Self-heal: no-diff failure for mars-72858ad4

- **Task:** Hard-cap `claude -p` sessions at 100 messages via
  `MARS_CLAUDE_MAX_MESSAGES` (orchestrator subprocess plumbing).
- **Branch:** `task/mars-72858ad4`
- **Failing step:** `verify:has-diff`
- **Failure signature:** `5d9f8e1a2f8ea1a1`
- **Retry count:** 1 (first no-diff for this task id)

## What happened

`verify:has-diff` reported "no commits ahead of integration branch — task
did not produce any changes" on `task/mars-72858ad4`.

This is **not** a `claude -p` no-op. The branch tip is
`2242e1f feat(orchestrator): hard-cap claude -p sessions at 100 messages
via MARS_CLAUDE_MAX_MESSAGES …` — a real, substantive commit (164
insertions across `run-claude-code-cap.test.ts` and
`orchestrator/src/mastra/lib/git.ts`) that **has already been merged into
`main`**. `git merge-base main task/mars-72858ad4` resolves to the task
branch tip itself, so `main..task/mars-72858ad4` is legitimately empty.

In other words: the work shipped, main fast-forwarded past it, and
`verify:has-diff` re-ran on the now-stale branch and (correctly, given
its rule) saw no commits ahead.

## Assessment

This recurrence is structurally different from the two known families:

1. **Oversized-prompt no-ops** (the `'interrupted'` TaskStatus +
   daemon-restart chain — `mars-209eb596` → `mars-00cc790e` →
   `mars-38636665` → `mars-042440db` → `mars-74aa7403`): `claude -p` runs
   out of message budget and never writes any files. Branch tip equals
   `main`, no feature commit exists anywhere.
2. **Transient `claude -p` no-op** (e.g. `mars-54463193` Triage Queue
   first recurrence): branch tip equals `main`, prompt was shaped fine,
   recommend re-enqueue as-is.

mars-72858ad4 is **neither** — it is a "ghost no-diff": the branch did
its job, the commit is on `main`, and `verify:has-diff` is firing on
post-merge dust. The fix-fail recipe should ideally short-circuit when
`git merge-base $INTEGRATION_BRANCH $TASK_BRANCH == $TASK_BRANCH`
(i.e. the task branch is fully ancestor of integration), recognise the
task as already merged, and close it `done` instead of routing to
self-heal.

## Recommendation

- **No code action on mars-72858ad4.** The work it represents is on
  `main`; re-running it would be a no-op or a duplicate.
- **Latent orchestrator bug:** `verify:has-diff` (and the surrounding
  fix-fail handler) should detect the "branch already merged into
  integration" case and treat it as success, not as `verify:has-diff`
  failure. File this as a separate `mars task add` so the no-diff
  recipe stops dispatching self-heal worktrees against ghost-merged
  branches.

## This commit

This file is the standard self-heal acknowledgement; it gives the
parent self-heal task a non-empty diff so its own `verify:has-diff`
clears, and it documents that mars-72858ad4 itself needs no further
action because its feature commit (`2242e1f`) is already on `main`.
