# Context note for mars-19b8362f — TaskStore seam migration

The first dispatch of mars-19b8362f aborted with
`too_hard:no-action-after-reads` after the implementor read
`mastra/index.ts`, `cli.ts`, and `mastra/queue.ts` (the latter is 1,514
lines), then ran one grep and one glob. The read budget was the cap, not
confusion — the parent brief is detailed but the work it describes is
multi-session.

This note records the analysis the unblock pass made and recommends a
slicing strategy. **Do not retry the parent as-is.** It should be
re-scoped into the four follow-ups listed below (filed via
`mars idea add`).

## Why the parent is too big for one session

ADR-0021 mandates a hard cut. The parent prompt faithfully translates
that into "remove `getClient`/`initQueue` exports, migrate every caller
in the same task." The footprint that actually implies:

- `queue.ts` itself exports **~30 domain functions**, each of which
  calls `getClient()` and most of which call `initQueue()` (lines 224,
  587, 633, 792, 813, 836, 900, 963–965, 973–981, 990–991, 1018–1019,
  1053–1054, 1123–1130, 1139–1143, 1155–1156, 1194–1195, 1203–1204,
  1228–1229, 1264–1265, 1283–1284, 1301–1302, … verified by `rg -n
  'getClient\(\)|initQueue\('` — 40+ hits in queue.ts alone).
- Two write-paths use `c.transaction('write')` directly
  (`updateTask` at queue.ts:912, `dropTask` at queue.ts:1087); both
  must move under the new `atomic(scope => …)` primitive that hides
  the `Transaction` object entirely and revokes the scope after the
  callback settles. This is **net-new code** with non-trivial
  semantics (non-nestable, post-callback revocation throws, returning
  commits, throwing rolls back and rethrows) — it deserves its own
  test surface before any caller depends on it.
- Seven lib modules hand-roll SQL on the raw client and must be
  migrated: `lib/origin.ts`, `lib/origin-timeline.ts`,
  `lib/reflect-query.ts`, `lib/reflect-signals.ts`,
  `lib/deep-reflect-query.ts`, `blocker-resolution.ts`,
  `queue-retry.ts`.
- **18 modules** import from `./queue` (workflows, daemon, workers,
  CLI, etc.). The ADR's "constructor injection at the composition
  root" requires inventing that root — `mastra/index.ts` currently
  configures the Mastra container only; it does not wire any
  queue-side dependencies. `getClient()` is a module-level singleton
  resolved lazily through `resolveContext()` (queue.ts:213-221). There
  is no DI seam to thread the store through today; the migration has
  to build that seam as a precondition.
- Tests: 11+ files under `mastra/lib/__tests__/queue-*` and
  `blocker-resolution.test.ts` /
  `deep-reflect-query.test.ts` exercise the existing public surface.
  They must keep passing as the surface changes, plus at least one new
  test covers atomic rollback + scope revocation.

A single implementor session that touches >40 functions across 8+
production files plus tests plus a novel transaction primitive does
not fit any reasonable read/edit budget. The read trail that tripped
the watcher was the **minimum** discovery to scope this; the
implementor was not confused, it was right-sized for a smaller slice.

## Recommended slicing (4 follow-ups, filed via `mars idea add`)

The four slices below are designed so each fits a single implementor
session (one design + one or two files + co-located tests). They
preserve ADR-0021's hard-cut endpoint but stage the cut so each step
is independently verifiable.

1. **Slice 1 — Introduce the TaskStore module (no migrations yet).**
   New `orchestrator/src/mastra/store/task-store.ts` exporting
   `createTaskStore(client: Client): TaskStore`. Implements:
   - typed domain methods that *delegate to the existing queue.ts
     functions* (same signatures, same behaviour — this is a thin
     pass-through);
   - the `query` / `execute` / `atomic` side door with the
     revocable-scope semantics (non-nestable, post-callback retained
     reference throws, returning commits, throwing rolls back &
     rethrows);
   - lazy memoised migration runner that wraps the existing
     `initQueue` body (still callable from queue.ts module-init for
     this slice).
   Tests: construct with `:memory:`, exercise `atomic()`
   rollback-on-throw and post-callback scope revocation.
   `getClient`/`initQueue` remain exported from `queue.ts`. No
   callers change. Verify: `npm run build` + new store tests pass.

2. **Slice 2 — Wire the store at the composition root and thread it
   into the daemon + workflow steps.** Build the DI root
   (`mastra/index.ts` or daemon boot — verify which by reading
   `daemon/server.ts`'s lifecycle; this is the slice that
   crystallises the answer). Convert the daemon and the four
   workflows (`implement-workflow`, `triage-workflow`,
   `slice-workflow`, `plan-workflow`) to receive a `TaskStore`
   instance instead of importing queue helpers directly. The 7 lib
   modules and CLI handlers stay on raw `getClient()` for now. Verify:
   `npm run build` green, full vitest run green.

3. **Slice 3 — Migrate the 7 lib modules off raw SQL onto the
   injected store.** `lib/origin.ts`, `lib/origin-timeline.ts`,
   `lib/reflect-query.ts`, `lib/reflect-signals.ts`,
   `lib/deep-reflect-query.ts`, `blocker-resolution.ts`,
   `queue-retry.ts`. Each currently calls `getClient()` directly;
   replace with a store dependency (constructor arg or function
   parameter — match the module's existing shape). DuckDB span
   reads in `origin-timeline.ts` are explicitly out of scope per
   ADR-0021 and stay on a separate connection. Verify: `npm run
   build` + the existing `__tests__/blocker-resolution.test.ts`,
   `deep-reflect-query.test.ts`, and reflect tests.

4. **Slice 4 — Final hard cut: delete `getClient`/`initQueue` from
   `queue.ts`'s public surface; move migration inside the store; move
   `rowToTask` into the store.** At this point every caller is on the
   store, so the cut is mechanical. CLI handlers (`cli.ts` and the
   `cli/**/*.ts` modules — confirm count via
   `rg "from '\./queue'" orchestrator/src/cli`) move onto the store
   in the same slice. Verify the leak is closed with:
   ```
   rg -n 'getClient|initQueue' orchestrator/src --type ts \
     --glob '!**/templates/**' --glob '!**/__tests__/**' \
     --glob '!**/task-store.ts'
   ```
   must print nothing. `npm run build` green; full vitest run green.

## What this unblock pass did NOT do

- It did not implement any slice. Per the unblock prompt's scope
  ("Do NOT attempt to complete the parent task — your scope is
  unblocking it"), this pass only analysed and filed follow-ups.
- It did not write the new ADR text — ADR-0021 already exists and is
  the source of truth.
- It did not touch `CONTEXT.md`; the `TaskStore` glossary entry, if
  needed, is owned by the writer pipeline.

## Recommendation for the operator

Drop `mars-19b8362f` (`mars unblock mars-19b8362f` then
`mars purge mars-19b8362f`) once the four `mars idea add` follow-ups
above have been triaged into queued tasks. The current parent is too
broad to dispatch — re-scoped slices are tractable.
