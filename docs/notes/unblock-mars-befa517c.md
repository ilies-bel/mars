# Unblock context: mars-befa517c (finish originId integration, idea 478c4083 step 4)

Status: context note for the re-dispatched implementor of **mars-befa517c**
("Finish the originId integration — `mars origin show` CLI verb +
deep-reflect originContext").

## Why the first attempt died

The prior implementor was aborted with `too_hard:no-action-after-reads`
after reading the workflows dir, `deep-reflect-query.ts`,
`deep-reflector.ts`, and `cli.ts` (twice) with **zero edits**.

That is not the agent failing — it is a **false premise in the brief**.

The brief's "Background — what already exists, do not duplicate" section
asserts:

> `orchestrator/src/mastra/lib/origin-timeline.ts` — exports
> `loadOriginTimeline(originId): Promise<OriginTimeline>` with shape
> `{ origin, tasks, spans }` …

**This file does not exist on `main`.** It was deleted in commit
`813da93` ("remove dead origin-timeline and load-manifest modules") — a
164-line module removed as dead code. Both scopes of mars-befa517c
import `loadOriginTimeline` / `OriginTimeline` / `OriginTimelineSpan`
from that missing path:

- Scope 1 (`mars origin show <id>`) is built entirely on
  `loadOriginTimeline`.
- Scope 2 (deep-reflect `originContext`) calls `loadOriginTimeline` to
  populate the new field.

So the implementor had no surgical action available — the central
dependency was absent — and correctly did not fabricate a 164-line
two-database module that the brief explicitly says "already exists, do
NOT redo". It stacked reads and was killed.

## What has been done to unblock

A prerequisite task has been filed and mars-befa517c is now **blocked on
it**:

- **mars-5648ba42** — "Restore
  `orchestrator/src/mastra/lib/origin-timeline.ts`". It rebuilds
  `loadOriginTimeline` / `OriginTimeline` / `OriginTimelineSpan` for the
  **current** data layer (the deleted version used `@mastra/duckdb` +
  the `proposals` module + `kind: 'proposal' | 'task'`; the current
  contract is libsql `mastra_ai_spans` via
  `json_extract(metadata, '$.originId')` and `kind: 'idea' | 'task'`).
- Blocker edge: `mars block mars-befa517c mars-5648ba42` (verified).

mars-befa517c will re-dispatch automatically once mars-5648ba42 reaches
`done`. **Do not start Scope 1/2 work until `origin-timeline.ts` exists
on the branch base** — `git ls-files orchestrator/src/mastra/lib/origin-timeline.ts`
should print the path before you begin.

## Corrected / verified facts for the re-dispatched implementor

Treat the brief's Background bullet about `origin-timeline.ts` as
"provided by mars-5648ba42", not "already on main". Everything else in
the brief was checked and holds, with these clarifications:

- `resolveOriginIdForTask` **does** exist:
  `orchestrator/src/mastra/lib/origin.ts` exports
  `resolveOriginIdForTask(taskId): Promise<string>` — returns
  `origin_id` or falls back to the task id. Import as the brief says.
- "idea" in the brief == the **`proposals`** module in code (there was
  an idea→proposal data-layer rename, commit `e968d85`). `getProposal`
  lives at `orchestrator/src/mastra/proposals.ts:584`. mars-5648ba42
  maps a proposal hit to `origin.kind === 'idea'`, so the consumer code
  in cli.ts / deep-reflect can use `'idea' | 'task'` as the brief
  describes.
- `deep-reflect-query.ts` already has `resolveOriginIdForTaskOrSelf`
  (around line 542) in addition to importing from `./origin`. Reconcile
  to a single resolver when wiring Scope 2 — don't add a third.
- `tasks.origin_id` + `idx_tasks_origin_id` exist in `.mars/queue.db`;
  backfill is complete. Do **not** touch the migration, index, or
  queue.ts INSERT paths (still out of scope, as the brief says).
- Span stamping in implement/plan/triage/slice workflows is already
  merged. Do **not** add new span stamping.

## Scope reminders carried over from the parent brief

- Only `mars origin show` (+ `mars origin` help). No `origin list` or
  other subcommands.
- No `ui/` surface — file a separate idea if wanted.
- Do not load `CONTEXT.md` or write `docs/adr/**` from the worktree;
  glossary terms (`originId`, `OriginTimeline`) are an operator
  post-merge step.
- Load the `mastra` skill before editing anything under
  `orchestrator/src/mastra/**`.
- Verify with `cd orchestrator && npx tsc --noEmit` (must be clean) then
  the `mars origin show …` smoke tests in the brief.
- Conventional commit prefix `feat(origin)`; commit body mentions this
  finishes idea 478c4083 step 4.

## For the orchestrator / re-dispatch

The blocker was a missing code dependency, not method-vs-watcher.
Re-dispatch is safe **only after mars-5648ba42 is `done`** — the daemon
will not flip mars-befa517c to `queued` until then. When it does, the
two scopes are actionable exactly as written, against the restored
`origin-timeline.ts`.
