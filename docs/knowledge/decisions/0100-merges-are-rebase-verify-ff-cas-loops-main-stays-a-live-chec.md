# Merges are rebase→verify→ff CAS loops; main stays a live checkout

# Merges are rebase→verify→ff CAS loops; main stays a live checkout

## Status
Accepted

## Context
`main` is triple-booked: it is the merge-target ref, the live working tree
the daemon runs from and the operator edits in, and the baseline every task
setup branches off. The 2026-08-20/21 incident showed the current merge
design cannot hold this: the merge lands via `git update-ref` (tree-free),
then a heuristic Step 3 re-syncs the primary checkout with `reset --hard`,
declining when it thinks it sees operator edits. Declined or interrupted
re-syncs leave the tree one merge behind its own HEAD, and `git status`
then reports the *inverse of the just-merged diff* as modifications —
phantom "operator edits" that were checkpointed under
`refs/mars/checkpoint/merge/*` (observed as a 94-line deletion of
`trace-events-store.ts` parked at 07:17 and the same 94 lines parked as an
insertion at 08:05). One such episode left main dirty, the dispatch-time
dirty-main guard failed setup for every waiting task, and each burned its
single recovery attempt on the same condition (~8 origin/fix pairs).
Separately, verify runs on the pre-rebase tree, so two individually-green
branches can compose into a broken main (semantic conflicts).

A tree-free `main` (no checkout on the integration branch) was considered
and rejected: having latest `main` available as a real working directory is
a product requirement.

## Decision
Every merge is an optimistic-concurrency loop:

1. `base = main`; rebase the task branch onto `base` in the task's own
   worktree (vcs-supervisor resolves conflicts there, never in the main
   checkout).
2. Run full verify on the rebased tree.
3. Take `.merge.lock`; if `main == base`, fast-forward via `update-ref`
   and release. Otherwise release and redo from step 1.

What lands on `main` is byte-for-byte the tree verify just passed, so the
ff is safe by construction and the semantic-conflict window is closed. The
lock guards only the compare-and-swap (milliseconds), not the rebase or
verify. Under contention a task redoes its rebase+verify; if that ever
dominates, the sanctioned dials are ordering the loop by queue position
(at most one redo per landing) and batching (merge trains) — not widening
the lock.

Operator dirt on the main checkout is handled by attribution, then
automation:

- **Stale-tree dirt** (the observed dirt equals the inverse of
  `lastSyncedSha..HEAD`) is machine debris: `reset --hard`, no commit, no
  checkpoint, no notification. The merge step records the sha it last
  synced the tree to precisely so this test is decidable.
- **Genuine operator dirt** (survives the test) is auto-committed — all
  tracked modifications, not just staged — as
  `wip(operator): auto-committed to unblock merge of <task>`, with a
  Notice telling the operator it happened and offering to disable the
  automation. With the lever off, the behaviour degrades to today's
  Alert and the queue parks. After an auto-commit, a cheap gate
  (typecheck) probes main and raises an Alert on failure; the merge
  proceeds either way.

Operator commits are ordinary commits on `main`: in-flight merges notice
at the CAS check and redo, rebasing over them like any other movement.
One rule for every writer: everything on main is a commit, and every
merge is rebase→verify→ff under the lock.

## Consequences
- Step 3's re-sync/classification/checkpoint machinery in
  `core/lib/git/merge.ts` (~200 lines, including
  `merge-left-dirty-tree` and the "preserved operator edits" path) is
  deleted, not repaired.
- Verify cost rises on busy days (redone verifies under contention);
  accepted, with queue-ordering and batching as the escape hatches.
- An auto-committed operator wip can be a broken baseline; the typecheck
  probe bounds detection latency to seconds, and the operator can amend
  before anything builds on it.
- The dirty-main dispatch guard's remit shrinks to genuinely
  unattributable dirt with the automation lever off.
