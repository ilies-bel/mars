# No-diff acknowledgment: 0ba9c38c

Fix-fail task `0ba9c38c` (branch `task/0ba9c38c`,
`fixForTask: mars-12328f92`, `failureSig: dirty_merge_target`,
`retryCount: 1`) was auto-dispatched by `agent:fail-fix-handler` to
clean uncommitted changes on the merge target before
`mars-12328f92`'s fast-forward merge. Per `mars show 0ba9c38c`, the
prompt's `git status --porcelain` snapshot listed two modified files:

```
 M .claude/commands/mars/next.md
 M orchestrator/src/mastra/ideas.ts
```

Verify failed with:

```
no commits ahead of integration branch — task did not produce any changes
```

## Why there is no diff

The dirty merge target is no longer dirty. By the time this fix-fail
worktree ran, both files had been reconciled on `main` by a sibling
agent / merge pass — `git status --porcelain` against
`/Users/ib472e5l/project/perso/mars-framework` is now empty. There was
nothing left for the recipe to commit, discard, or escalate to inbox.

This is exactly the race that commit `fdcdfd2`
(`fix(orchestrator): make dirty-merge-target fix recipe re-check git
status before acting`) was written to handle: the recipe re-checks
status before mutating the tree, and treats a clean tree as a clean
no-op rather than synthesizing edits or inbox notes from the stale
prompt snapshot. The agent did the right thing (no-op), but a clean
no-op produces no commit, which then trips `verify:has-diff` — same
shape as `NO-DIFF-mars-2989405d.md` /
`NO-DIFF-mars-e3c1704d.md` / `NO-DIFF-mars-08b123c5.md` /
`NO-DIFF-mars-924033ce.md`: the upstream condition the fix-fail row
was dispatched against has already been resolved by something else,
so there is nothing to repair.

## Why this fix-fail task is itself a no-op

There is no fixable failure left:

- `.claude/commands/mars/next.md` and
  `orchestrator/src/mastra/ideas.ts` are clean on `main` — the
  reconciliation already happened.
- The recipe's three branches (commit / discard / inbox-escalate) all
  require a non-empty `git status` to act on; the empty status leaves
  none of them applicable.
- `mars-12328f92` itself is `blocked` (its fast-forward attempt is
  what triggered this fix-fail in the first place); whether it
  succeeds on the next dispatch depends on its own re-attempt, not on
  this row.

This commit exists solely to satisfy the orchestrator's
`verify:has-diff` check so the fix-fail row can close cleanly without
re-triggering yet another fix-fail dispatch on top of an
already-resolved no-op.

## Real follow-up

The structural follow-up has already shipped (`fdcdfd2`): the recipe
now re-checks status before acting. What is *not* yet handled is the
verify-side half of the same race — a dirty-merge-target fix-fail
dispatch that legitimately decides to no-op (because the dirt is
gone) should not be retried as a `verify:has-diff` failure, because
that just spawns another fix-fail row on top of an already-resolved
condition. Two concrete shapes for closing the loop:

1. **Recipe-side ack commit.** When the dirty-merge-target recipe
   re-checks `git status` and finds it clean, write a one-line
   acknowledgment commit on the fix-fail branch (e.g. an empty
   `chore(self-heal): merge target clean on re-check` commit, or a
   trivial doc under `orchestrator/scripts/`) so verify finds a diff
   and the row closes naturally instead of being kicked back into the
   fail-fix loop. This avoids the manual `NO-DIFF-*` paperwork pass
   for this specific signature.

2. **Fix-fail-handler signature suppression.** Teach
   `agent:fail-fix-handler` to recognise the
   `(failureSig=dirty_merge_target, verifyError=verify:has-diff)`
   pair on a row whose own `fixForTask` row's merge target is now
   clean, and short-circuit to `done` (or `dropped`) rather than
   queueing another retry. Same end state, slightly more invasive.

Either change makes this class of clean-no-op self-heal cycle
short-circuit at the orchestrator instead of leaking into a manual
acknowledgment commit. Both are out of scope for this acknowledgment
and should be filed as a separate `mars task add` entry by the human
operator who reads this row.
