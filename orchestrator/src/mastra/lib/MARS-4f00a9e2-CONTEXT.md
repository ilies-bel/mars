# mars-4f00a9e2 — scoping note for "Remove total_cost_usd from reflect-signals storage layer"

Slice 3 of 8 for PRD `1b7498f6-remove-all-usd-cost-usd-mentions-from-th`.

The previous implementor (and the parent context-gathering task
`mars-45d9abd8`) both aborted with `too_hard:no-action-after-reads`.
The reason is a real ambiguity in acceptance criterion #1, not a
missing helper. This note resolves it so the next implementor can act
immediately.

## The ambiguity

AC list as written:

1. Schema definition for reflect signals contains no `total_cost_usd`
   column
2. Insert/update statements omit `total_cost_usd`
3. Read shape type has no `totalCostUsd` field
4. Unit tests for reflect-signals pass with token-only fields

ACs 2–4 are local to `orchestrator/src/mastra/lib/reflect-signals.ts`.
AC 1, taken literally, demands editing the `CREATE TABLE task_signals`
block in `orchestrator/src/mastra/queue.ts` (lines 392–421) — including
removing the `total_cost_usd` column from the schema and dropping the
migration shim below it.

Doing that in this slice is **out of scope and breaking**, because two
sibling readers still `SELECT total_cost_usd FROM task_signals`:

- `orchestrator/src/mastra/lib/reflect-query.ts` (lines ~295–320,
  feeding `mars reflect` CLI output)
- `orchestrator/src/mastra/lib/deep-reflect-query.ts` (lines ~44–68,
  ~450–485, feeding `mars deep-reflect`)

Dropping the column from `CREATE TABLE` makes new DBs fail those
SELECTs, while the `IF NOT EXISTS` no-op leaves old DBs unaffected —
i.e. it half-breaks the system in a way the verify command will catch
only on a fresh `.mars/queue.db`.

## Resolution — narrow this slice

This slice is *the persistence module*, not *the table schema*.
Implement it as:

1. **`reflect-signals.ts`** (the only production file to edit):
   - Remove `total_cost_usd` from the `INSERT … VALUES (…)` column
     list, the `ON CONFLICT … DO UPDATE SET` block, and the matching
     `args` array. Drop the `0` placeholder and the comment above it.
   - Remove `totalCostUsd: number` from the `TaskSignalRow` interface.
   - Remove `total_cost_usd` from the `SELECT` in `listTaskSignals` and
     drop the `totalCostUsd: Number(r0.total_cost_usd ?? 0)` field from
     the row mapper.
2. **`__tests__/reflect-signals.test.ts`** (new file — no test file
   exists yet for this module; that absence is part of why the
   previous implementor stalled):
   - Tracer bullet: `recordSignals` then `listTaskSignals` round-trips
     token fields, with no `totalCostUsd` key on the returned row.
   - One test asserting `MARS_REFLECT_DISABLED=1` makes `recordSignals`
     a no-op.
   - One test asserting `ON CONFLICT` updates token fields in place
     (call `recordSignals` twice with the same `(taskId, stepId)` and
     differing totals; assert the second wins).
   - Pattern off `__tests__/deep-reflect-query.test.ts` for queue/db
     bootstrap (`initQueue`, an in-memory or temp-file libsql client).
     **Do not** import `task_signals` schema bits from `queue.ts` — use
     `initQueue()` only.
3. **Do NOT touch** `queue.ts` schema, `reflect-query.ts`, or
   `deep-reflect-query.ts` in this slice.

## What about AC #1?

Reinterpret it as "the schema **as exposed by the reflect-signals
module** declares no `totalCostUsd` field" — i.e. the read shape
(`TaskSignalRow`) and the column list referenced in this module's SQL.
The physical SQLite column in `task_signals` survives this slice; a
later slice in the PRD will drop the column from `queue.ts`, remove
the migration shim, and update the two reader modules in the same
change. Per project policy (no migration windows, hard cuts) those
edits belong together — splitting them across slices is what made this
slice's AC #1 misleading.

Recommend the next implementor:

- complete the narrow scope above,
- commit it,
- file a follow-up via `mars task add "Drop total_cost_usd column from
  task_signals and strip readers in reflect-query.ts +
  deep-reflect-query.ts" --blocked-by <this-task-id>` if the PRD's
  remaining 5 slices don't already cover that work (check `mars idea
  show 1b7498f6-remove-all-usd-cost-usd-mentions-from-th` first).

## Verify

```
cd orchestrator && npm test -- reflect-signals
cd orchestrator && npx tsc --noEmit
```

The typecheck must pass — `reflect-query.ts` and `deep-reflect-query.ts`
do not import from `reflect-signals.ts`, so removing `totalCostUsd`
from `TaskSignalRow` is a local change.
