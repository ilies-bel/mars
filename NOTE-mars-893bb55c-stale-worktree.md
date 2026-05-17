# Finding — mars-893bb55c re-abort root cause: stale worktree

## Status

**No-op investigation.** mars-893bb55c was re-dispatched after its first
abort, aborted again with `too_hard:no-action-after-reads` (5 identical
Globs of the worktree root, no actions). The cause is **not** missing
context — a comprehensive context note already exists on `main`.

## The existing context note

`CONTEXT-mars-893bb55c.md` was committed in `8c47373` ("context note for
mars-893bb55c: file inventory for idea→proposal rename") and is reachable
from `main` (current `main` HEAD: `b12956f`). The note inventories every
in-scope file (UI, six skill bodies + their template copies, six doc
files, glossary CLI commands, new-ADR CLI command), gives a suggested
execution order, and names the bail-out condition.

That note is sufficient. If a fresh implementor reads it and follows it,
the slice is tractable.

## Why the re-dispatch failed anyway

The `mars-893bb55c` worktree's HEAD is `c19a728` (Sun May 17 15:12:22
2026 +0200). The context-note commit `8c47373` landed at 17:38 the same
day — **after** the worktree was created. `git merge-base --is-ancestor
8c47373 c19a728` returns false: the implementor's checkout simply does
not contain `CONTEXT-mars-893bb55c.md`. They Glob'd the root looking
for it (and for anything else to anchor on), found nothing actionable,
and tripped the read-span watchdog.

This is a worktree-freshness issue, not a context-availability issue.

## What unblocks the next dispatch

Refresh `mars-893bb55c` onto current `main` before re-dispatching, so
the worktree includes `8c47373` (the context note) and the other
intervening commits. After the refresh:

```
git -C .mars/worktrees/mars-893bb55c log --oneline | head -3
```

should show `b12956f` (or whatever `main` HEAD is at refresh time) as an
ancestor. Then the implementor's first read of
`CONTEXT-mars-893bb55c.md` gives them the full file inventory and they
can act.

No further context-gathering is needed on this side. The blocker on
mars-893bb55c is satisfied the moment the worktree is current with
`main`.

## Related follow-up

Filed an idea about ensuring orchestrator re-dispatches after a blocker
resolves rebase the dependent task's worktree onto current `main`, so
context notes produced by the blocker actually reach the implementor.
