# Grill decision: PRD 1b7498f6 (remove USD/cost-USD from reflect pipeline)

**Grilled by:** mars-8b6cbcf8 (auto)
**Date:** 2026-05-17
**Verdict:** REAFFIRM with scope amendment to slice 5.

## Trigger

Commit `d93da17` (Sun May 17 17:03:30 2026,
`fix(queue): backfill task_signals.total_cost_usd on existing DBs`) landed on
`main` while seven slices of PRD 1b7498f6 sat in `blocked` / `failed`:

| slice            | status   | role                                            |
| ---------------- | -------- | ----------------------------------------------- |
| mars-790f3a35    | blocked  | consumer                                        |
| mars-45d9abd8    | blocked  | consumer                                        |
| mars-f933ef97    | blocked  | consumer                                        |
| mars-254048b7    | blocked  | consumer                                        |
| mars-a215f361    | failed   | slice 5 — drops `total_cost_usd` from CREATE TABLE |
| mars-385f02c3    | blocked  | (downstream)                                    |
| mars-f73d43a2    | blocked  | (downstream)                                    |

d93da17 adds a runtime `ALTER TABLE task_signals ADD COLUMN total_cost_usd ...`
to `orchestrator/src/mastra/queue.ts` so existing DBs gain the column the PRD
is about to remove. The PRD and main are moving in opposite directions.

## Which of (a) (b) (c)?

The user framed three hypotheses. The evidence points to **(a)**:

- d93da17's commit message is a defensive bug-fix idiom ("backfill ... on
  existing DBs"), not a product statement like "we still want USD reporting".
- It uses the same `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` shape used
  elsewhere in `initQueue` to plug schema-drift bugs.
- PRD user story [4] is explicit: *"no migration is shipped — existing repos
  are expected to mars rebuild (or accept that the column lingers as dead
  storage until rebuild)."* d93da17 is precisely the migration the PRD said
  not to ship.

So: PRD direction is right; d93da17 was enqueued without the author noticing
1b7498f6.

## Verdict

**REAFFIRM the PRD.** Tokens-as-stable-unit reasoning is unchanged; nothing
about pricing or reporting needs has shifted. The PRD's hard-cut posture
("no migration; existing rows lingering is acceptable") was deliberate and
remains the right call.

## Scope amendment

Slice 5 (`mars-a215f361`, "Drop total_cost_usd from queue.db task_signals
schema") must be re-specified to remove **both**:

1. the `total_cost_usd REAL ...` line from the `CREATE TABLE task_signals` in
   `orchestrator/src/mastra/queue.ts` (already in scope), **and**
2. the d93da17 backfill block immediately below (the `PRAGMA table_info` +
   `ALTER TABLE ADD COLUMN total_cost_usd` defensive migration — also in
   `queue.ts`, ~lines 408-419 as of d93da17).

Without (2), slice 5 leaves the column being re-created at runtime on every
`initQueue` call against any DB that already dropped it, which both contradicts
the PRD and breaks the slice's own acceptance criterion.

These are adjacent edits to the same file; no extra slice needed — just a
re-spec of mars-a215f361 before re-dispatch.

## Ordering

No other re-ordering required. The consumer slices (790f3a35, 45d9abd8,
f933ef97, 254048b7) already block slice 5 in the current edge graph; once
slice 5 is re-spec'd, the existing wave structure holds.

If anyone runs `mars reflect` between slice 1 (already on `chore/remove-total-cost-usd`
as 4d96140) merging to main and slice 5 merging, they will read a DB column
whose write path the consumer slices have already turned off. That's fine —
the column reads as `0` (the column's DEFAULT) and the reflect prompt no
longer cites USD anyway.

## Follow-up actions taken by this task

- `mars idea set 1b7498f6 notes ...` — appended a `## Grill 2026-05-17`
  block to the PRD notes recording the d93da17 carve-out and the slice 5
  scope amendment.
- `mars task add ... --blocked-by mars-8b6cbcf8` — enqueued a re-spec of
  slice 5 (mars-a215f361) to also remove the d93da17 backfill block.
- This decision artifact, committed to the slice's worktree.

## What this task did NOT do

- Did not run `mars idea reject 1b7498f6` — PRD reaffirmed.
- Did not touch source files in `orchestrator/src/**` — shape-only task.
- Did not revert d93da17 directly on main — that revert is part of slice 5's
  re-spec and lands through the normal wave.
