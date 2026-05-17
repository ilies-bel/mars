# CONTEXT: mars-adf57f63 — parent mars-97dfcdab already resolved on main

**Task**: Context-gathering follow-up for `mars-97dfcdab` (slice 1/1 of
PRD `2e3782cf-prd-208a283c-rename-idea-to-proposal-sli`, "Dual-write
bridge: proposals tables + module alongside ideas"). Spawned because the
first implementor run on `mars-97dfcdab` aborted with
`too_hard:no-action-after-reads`.

**Verdict**: No code change required. The parent task has *already* been
resolved on `main` by commit `f457b20 context(mars-97dfcdab): slice
premise already inverted on main`, which landed before this follow-up
was dispatched. The blocker edge on `mars-97dfcdab` is therefore stale.

## Why the parent slice is unimplementable as written

The slice asks for a *dual-write bridge*: keep `ideas.ts` and the
`ideas` table as the live write target, add a parallel `proposals.ts`
module and `proposals` / `proposal_user_stories` tables, copy rows
across idempotently on startup, and leave the existing CLI / UI
unchanged.

That premise was authored against a pre-rename snapshot. Two shipped
commits inverted the direction before this slice ran:

- `e968d85 WIP(mars-23c9352d): rename idea->proposal in data layer
  (partial)`
- `522a3a9 Finish idea->proposal consumer cascade (Slice 1 of PRD
  208a283c)`

In the current tree (verified at this commit):

- `orchestrator/src/mastra/ideas.ts` does not exist — `git log --all --
  orchestrator/src/mastra/ideas.ts` shows the last touch was `e968d85`,
  which deleted it.
- `orchestrator/src/mastra/proposals.ts` is the live module. Its
  `initProposals` does a one-shot `ALTER TABLE ideas RENAME TO
  proposals` (and the same for `idea_user_stories` → `proposal_user_stories`,
  plus the `idea_id` → `proposal_id` column) per ADR-0010, then
  `CREATE TABLE IF NOT EXISTS proposals (...)`. There is no dual-write
  path and no `ideas` table left on disk after first daemon start.
- `orchestrator/src/mastra/__tests__/proposals-migration.test.ts` pins
  the opposite invariant: it asserts `!stateTables.has('ideas')` after
  startup. Re-introducing an `ideas` shim would break this test.

Satisfying `mars-97dfcdab`'s acceptance criteria literally — "ideas
tables remain the live write target", "ideas module re-exports
Proposal as Idea while its client and init functions still target the
ideas table" — would require reverting both shipped commits, restoring
the `ideas.ts` shim, and reintroducing the `ideas` SQL surface
alongside the now-canonical `proposals` one. That is a destructive
architectural reversal, not a tracer-bullet implementation slice.

## Why this follow-up exists at all

The orchestrator's read-watch span aborted the first implementor run
on `mars-97dfcdab` after 5 consecutive Read/Grep calls without an
Edit/Write/Bash. A *second* implementor run on the same task wrote and
merged `f457b20`, but the queue still carried the original
`mars-adf57f63` follow-up edge created from the first run.

Per repo precedent (`5989df3`, `150d4c0`, `adb8e52`, `2bc63cc`,
`a15bcf9`, `f457b20`, ...), the right action is a context note rather
than manufactured churn. After this commit lands:

- `mars-adf57f63` (this task) is done — the context the implementor
  needed is "the parent is already resolved on main, no further work
  is required."
- `mars-97dfcdab` can be `mars purge`d; its resolution is already on
  `main` and the verify gate has nothing new to check.

The live outstanding piece of the parent PRD — the CLI-layer rename
(`mars idea …` → `mars proposal …`) — is a separate slice and out of
scope here.
