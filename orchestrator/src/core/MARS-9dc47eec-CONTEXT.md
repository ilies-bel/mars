# mars-9dc47eec — redundant context-gathering for mars-19b8362f

**Task:** `mars-9dc47eec` — context-gathering follow-up dispatched
because the implementor agent for `mars-19b8362f` (TaskStore seam
migration, ADR-0021) hit `too_hard:no-action-after-reads` after 5 reads
without an action.

**Status:** Redundant. The unblock note this follow-up was created to
produce **already exists on `main`** at
`orchestrator/src/core/MARS-19b8362f-CONTEXT.md` (committed as
`eb6c57f context note for mars-19b8362f: TaskStore migration is too big
for one session`).

## Why nothing remains to gather

`MARS-19b8362f-CONTEXT.md` already covers:

- Why the parent prompt is multi-session (it faithfully translates
  ADR-0021's hard cut into a touch-everything edit: ~30 functions in
  `queue.ts`, two `c.transaction('write')` sites that must move under a
  novel `atomic(scope => …)` primitive, 7 lib modules hand-rolling SQL,
  18 importers of `./queue`, 11+ test files binding to
  `getClient`/`initQueue` via `vi.mock`).
- A four-slice plan that preserves ADR-0021's endpoint but stages the
  cut: (1) introduce `TaskStore` as a pass-through over `queue.ts` +
  `atomic`/`query`/`execute` side door with tests, (2) wire DI at the
  composition root and convert daemon + workflows, (3) migrate the 7
  lib modules, (4) final hard cut deleting `getClient`/`initQueue` from
  `queue.ts` and moving CLI handlers over.
- A recommendation: `mars unblock mars-19b8362f` + `mars purge
  mars-19b8362f`, file the four slices via `mars idea add`, re-dispatch
  from there.

The original read trail (`index.ts`, `cli.ts`, `queue.ts`, one grep,
one glob) and the watchdog abort are also recorded there.

## Independently verified deviations from the parent brief

Spot-checks this pass made against the worktree confirm the existing
note's findings and surface two additional issues worth flagging
when the slices are filed:

- **`lib/origin-timeline.ts` does not exist** in
  `orchestrator/src/core/lib/` — the parent prompt lists it as one of
  the "7 live modules" to migrate. ADR-0021 also references it as a
  DuckDB span reader. Either the file was removed since the brief was
  written, or it was always misnamed (cf. `lib/read-span-watch.ts`,
  which does exist). The slicing plan in `MARS-19b8362f-CONTEXT.md`
  inherits this stale name in Slice 3 — fix it when the slice is
  filed.
- **Brief understates the call-site count.** Beyond the 7 listed
  modules, `rg getClient\|initQueue orchestrator/src --type ts` also
  flags `queue-fix-tasks.ts` (heavy use), `init/databases.ts`,
  `daemon/server.ts`, `workflows/slice-workflow.ts`, and `proposals.ts`
  (dynamic-imports `initQueue` and re-declares its own private
  `getClient` against `state.db` — that one belongs to the StateStore
  half of ADR-0021, not TaskStore). The four-slice plan in the prior
  note covers these implicitly (Slices 2 and 4) but the parent brief
  enumerates only the lib subset.

## Recommended disposition

- `mars unblock mars-9dc47eec` then `mars purge mars-9dc47eec` — this
  follow-up has no remaining scope.
- Disposition for `mars-19b8362f` itself is the one already proposed in
  `MARS-19b8362f-CONTEXT.md`: purge it and re-file as four scoped
  slices via `mars idea add`.

## Watchdog bug, again

This is the second time the no-action-after-reads watcher has fired on
a parent that already had a sibling `MARS-<parent-id>-CONTEXT.md` on
`main`, producing a redundant context-gathering child (see
`MARS-817fa15d-CONTEXT.md` in `orchestrator/src/core/agents/`). The
recommended fix recorded there still applies: when the watcher trips
and a sibling unblock note already exists, the dispatcher should
short-circuit (auto-mark the new follow-up `done` with the existing
note as its artifact) rather than queue another gathering pass.
