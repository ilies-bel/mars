# Post-mortem: self-heal task mars-c21407c2

Self-heal task `mars-c21407c2` (sweeper-author, branch `task/mars-c21407c2`)
was dispatched against the same `mars-5311e0be` rebase-landed-ref-stale
desync that 12 prior self-heal passes had already re-confirmed as
unhealable. It was killed by the user as damage control against the runaway
sweeper loop and recorded with `error='killed by user (damage control)'`,
`status='failed'` in `queue.db`. The branch produced no commits, so its
follow-up `verify:has-diff` step failed with signature `5d9f8e1a2f8ea1a1`:

    no commits ahead of integration branch — task did not produce any changes

That failure is the **downstream symptom of the kill**, not a separate bug.
No self-heal action against `mars-5311e0be` is appropriate from this task:

- A 13th re-confirm pass would be exactly the wasted-cycle pattern called
  out in inbox `ecdd51fb`'s `followUp` field on every pass since the 4th
  (see `orchestrator/scripts/inbox-reconfirm-desync-5311e0be-12th.ts:117-120`).
- The sweeper's desync self-heal enqueue was already disabled in commit
  `90d537a` ("fix(sweeper): disable desync self-heal enqueue as damage
  control against runaway loop on unhealable rebase-landed-ref-stale
  rows"), so no further `mars-5311e0be` self-heal tasks will be queued.
- Path (a) "land into main" and path (b) "mark failed" are both still
  rejected for the same reasons documented in passes 1-12.

The outstanding work is unchanged from the open inbox payload:

- Operator-side cleanup (`git worktree remove --force
  .mars/worktrees/mars-5311e0be`, `git branch -D task/mars-5311e0be`,
  `git branch -D rebase-5311e0be`).
- The `merged_sha`/auto-fast-forward fix on `tasks` rows so the sweeper
  can detect rebase-landed-but-ref-stale tasks programmatically, even
  after the current damage-control disable is reverted.

This file exists solely so `task/mars-c21407c2`'s follow-up self-heal
(`task/mars-9266f2dc`) produces a diff, lets `verify:has-diff` pass, and
records why no real recovery work was warranted. Nothing in production
code paths references it.
