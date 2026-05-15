# Unblock note for mars-12b23ecb — slice work already on main

Slice 1/5 of PRD `478c4083-stamp-every-mastra-span-with-an-originid`
asked for the `tasks.origin_id` schema column, backfill, default, index,
and a glossary entry for `originId`. All five acceptance criteria are
**already satisfied on main** — the implementor agent had nothing to
write, kept reading to find the gap, and the read-span watcher killed it
after 5 reads.

## Acceptance criteria vs current state on `main`

| Acceptance criterion | Current state |
| --- | --- |
| Every existing tasks row has `origin_id` equal to its `id` after migration | **Met.** `orchestrator/src/mastra/queue.ts:329-332` adds the column when missing and runs `UPDATE tasks SET origin_id = id WHERE origin_id IS NULL`. |
| A freshly inserted task via the direct CLI path has `origin_id` equal to its `id` | **Met.** `enqueueTask` at `queue.ts:750` does `const originId = opts?.originId ?? id` and writes it through the INSERT at `queue.ts:766`. |
| Running the migration twice in a row leaves schema and data unchanged after the first run | **Met.** The ALTER is gated by `if (!names.has('origin_id'))` (`queue.ts:329`); the backfill UPDATE is also a no-op on the second pass because the column is already populated. |
| An index on `tasks(origin_id)` exists and is used by lookups filtering on `origin_id` | **Met.** `CREATE INDEX IF NOT EXISTS idx_tasks_origin_id ON tasks(origin_id)` at `queue.ts:376`. Used by `listSiblings` (`queue.ts:1217`) and `listTasksForIdea` (`queue.ts:1238`). |
| `mars glossary show originId` returns a non-empty definition | **Met.** Verified at unblock time — returns the "Tracer id for a full workflow from `mars idea add` …" definition. The entry is also in `CONTEXT.md:14`. |

## Test coverage already in tree

`orchestrator/src/mastra/lib/__tests__/queue-origin-id.test.ts` contains
four tests that lock in exactly the four behavioural acceptance criteria
(idempotency, default = id on direct insert, explicit `originId` opt,
backfill on legacy rows). Run on the worktree's own copy of `queue.ts`:

```
$ cd orchestrator && npx vitest run src/mastra/lib/__tests__/queue-origin-id.test.ts
 ✓ src/mastra/lib/__tests__/queue-origin-id.test.ts (4 tests) 218ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

## Why the implementor stalled

`task/mars-12b23ecb` branched off `main` before any divergent commits
were added; `git merge-base HEAD main` equals `HEAD` (the branch has
zero commits ahead). Its tree therefore already contains the
`origin_id` column, the backfill, the index, the `enqueueTask` default,
the `Task.originId` field, the four acceptance-criteria tests, and the
`originId` glossary entry. The implementor read `glossary.ts`, `cli.ts`,
`context.ts` looking for the seam to extend — there is no seam to
extend, the work is done — and the watcher killed the session.

## Recommended next step

Close `mars-12b23ecb` as `done`. The slice has shipped; the tests are
green; no follow-up work is in scope. The remaining four slices of PRD
`478c4083` (which the implementor was not asked to handle) are
unaffected by this disposition.

If a maintainer wants belt-and-braces evidence beyond the existing
tests, the verify command on the parent worktree already exercises the
migration end-to-end on a fresh `.mars/queue.db`:

```
cd orchestrator && npx vitest run src/mastra/lib/__tests__/queue-origin-id.test.ts
```

No code change is needed in `mars-12b23ecb` to land the slice's stated
behaviour.
