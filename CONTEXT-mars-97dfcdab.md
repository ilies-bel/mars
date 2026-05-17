# mars-97dfcdab — slice premise already inverted on main

Slice: "Dual-write bridge: proposals tables + module alongside ideas"
(PRD 2e3782cf-prd-208a283c-rename-idea-to-proposal-sli, slice 1/1).

## What the slice asks for

A startup migration creates a new `proposals` / `proposal_user_stories`
table alongside the existing `ideas` / `idea_user_stories`, copies rows
across, and leaves `ideas` as the live write target. A new
`proposals.ts` module is introduced alongside `ideas.ts`. The `ideas.ts`
shim re-exports `Proposal` as `Idea` and `ProposalSource` as
`IdeaSource`, but its client and init functions keep writing to the
`ideas` table unchanged.

## What is actually on `main`

The rename has already shipped, in the **opposite** direction:

- `522a3a9` — "Finish idea->proposal consumer cascade (Slice 1 of PRD
  208a283c)" — completed the data-layer + consumer rename.
- `e968d85` — "WIP(mars-23c9352d): rename idea->proposal in data layer
  (partial)" — deleted `orchestrator/src/mastra/ideas.ts` and introduced
  `orchestrator/src/mastra/proposals.ts`.

Consequences vs. the slice text:

- There is no `orchestrator/src/mastra/ideas.ts`. The file has been
  removed; nothing in `src/` writes to an `ideas` table any more.
- `orchestrator/src/mastra/proposals.ts` performs a one-shot
  `ALTER TABLE ideas RENAME TO proposals` on startup. After the first
  daemon start, the `ideas` table no longer exists on disk.
- The CLI surface (`mars idea add`, `mars idea show`, ...) is still
  named with the `idea` vocabulary, but every verb already routes
  through `proposals.ts` and writes to the `proposals` table.
- `orchestrator/src/mastra/__tests__/proposals-migration.test.ts`
  explicitly asserts `stateTables.has('ideas')).toBe(false)` after
  `initProposals()` runs — i.e. the live tests pin the *opposite*
  invariant from the one this slice asks for.

## Why I am not implementing the slice

The acceptance criterion "ideas tables remain the live write target for
every existing caller" cannot be satisfied without:

1. Reverting `522a3a9` and `e968d85` (re-introducing `ideas.ts` and the
   `ideas` table as the live target).
2. Rewriting the existing `proposals-migration.test.ts` to flip its
   `expect(...).toBe(false)` invariants.
3. Re-introducing the `idea_*` SQL surface that has already been
   removed.

That is a destructive architectural reversal of two shipped commits,
not a tracer-bullet slice. Per the deviation rules (Rule 4: "Surface
architectural changes as new tasks") I am stopping here rather than
silently expanding scope or papering over the gap.

The PRD this slice belongs to (`2e3782cf-prd-208a283c-...`) appears to
have been authored against an older snapshot of the codebase, before
the rename cascade landed. The "later slice [that] will cut the CLI
from `mars idea` to `mars proposal`" the brief mentions is also still
outstanding — the CLI verbs still use `idea` even though the storage is
now `proposals`. That cut, not this dual-write bridge, is the live
piece of work; it does not need a bridge migration because the data
layer has already moved.

## Suggested follow-up

If the underlying intent is to finish the user-visible rename, the
remaining work is a CLI-layer rename only: introduce `mars proposal`
verbs (or rename `mars idea` → `mars proposal`) that call the existing
`proposals.ts` API. No database migration is needed; no `ideas.ts`
shim is needed.
