# No-diff acknowledgment: mars-6327f119

Task `mars-6327f119` (branch `task/6327f119`, signature
`5d9f8e1a2f8ea1a1`) failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

## Why this one is different from its siblings

Unlike the long cluster of `5d9f8e1a2f8ea1a1` no-diff failures that share
the same signature but trace back to oversized feature prompts (Inbox
tab, Tasks Graph view, sweeper dedup, Triage Queue UI, etc.), this row
is **not** a prompt-shape pathology. It is a `dirtyMergeTargetRecipe`
fix-fail dispatch (`author=agent:fail-fix-handler`,
`failureSig=dirty_merge_target`, `fixForTask=mars-159041cf`) that hit a
benign race:

1. The merge of `mars-159041cf` saw an uncommitted snapshot on `main`
   (` M .claude/commands/mars/next.md`,
   ` M orchestrator/src/mastra/ideas.ts`) and refused to fast-forward.
2. The orchestrator dispatched the dirty-merge-target recovery into a
   fresh worktree.
3. **Before** that recovery's `claude -p` actually ran, a sibling task
   committed/cleaned those two files away. By the time `claude -p` read
   `git status --porcelain` on `main`, the tree was already clean.
4. The recovery prompt at the time still asked the agent to "commit
   files / discard files / file an inbox note" without first
   re-checking. The agent correctly noticed there was nothing to commit
   or discard, exited cleanly, and produced no diff — which `verify`
   then flagged as `verify:has-diff`.

## Why no code change in this commit

The structural fix has already landed on `main` at `fdcdfd2`
("fix(orchestrator): make dirty-merge-target fix recipe re-check git
status before acting…"). That commit rewrites
`dirtyMergeTargetRecipe` (`orchestrator/src/mastra/lib/fix-recipes.ts`)
with an explicit STEP 1 — "re-check first; if `git status --porcelain`
is empty, do NOT touch anything, do NOT commit, do NOT emit an inbox
note, exit successfully — the original task can be retried as-is" —
and rewords the captured snapshot as "may be stale — re-check before
acting". The accompanying test in
`orchestrator/src/mastra/lib/__tests__/fix-recipes.test.ts` covers it.

`mars-6327f119` was queued at `2026-05-09T20:51:16.566Z`, before
`fdcdfd2` landed at `2026-05-09T23:40` (≈ 2h49 earlier). So it
inevitably ran with the **old** recipe text and produced the no-diff
the new recipe now explicitly endorses as the correct behaviour.

There is therefore no code-level repair this fix-fail handler can
make: the underlying race is already handled, and the merge target is
clean as of this writing (`git -C /Users/ib472e5l/project/perso/mars-framework status --porcelain` returns empty).
The right thing for the upstream task `mars-159041cf` is a plain
retry — it merges cleanly now.

## Recommendation

1. **Mark `mars-6327f119` as resolved (no-op)** in the queue rather
   than re-dispatching. Its purpose (clean a dirty merge target) is
   already accomplished by whichever sibling task did the actual
   cleanup; another `claude -p` round would just produce another
   identical no-diff acknowledgment file.
2. **Retry `mars-159041cf`** (the upstream feature task this row was
   trying to unblock). With `main` clean, the merge step will
   fast-forward without invoking `dirtyMergeTargetRecipe` at all.
3. **Audit any other in-flight `dirty_merge_target` fix-fail rows
   queued before `fdcdfd2`** (look for `failureSig='dirty_merge_target'`
   AND `createdAt < '2026-05-09T23:40Z'` in `.mars/queue.db`). Those
   were dispatched with the stale recipe and may produce the same
   no-diff outcome on a now-clean tree; they should be dropped rather
   than retried.

## Meta-observation

This is a clean example of the orchestrator self-healing the right
way — a structural fix lands on `main` (`fdcdfd2`) before the feedback
loop closes, and the in-flight worktrees that predate the fix surface
exactly the failure mode the new recipe was designed to absorb. The
remaining gap is operational: the queue should treat a
`dirty_merge_target` fix-fail row that comes back with no-diff as
"upstream race already resolved, retry the original task" rather than
re-dispatching the recovery worktree. That matches the
two-strikes / drop-and-reshape follow-up tracked across the wider
`5d9f8e1a2f8ea1a1` cluster.

Filed as a paper-trail commit so the failure signature
`5d9f8e1a2f8ea1a1` and its `fixForTask=mars-159041cf` linkage are
visible in `git log` next to its siblings.
