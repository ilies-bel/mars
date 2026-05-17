# Unblock note for mars-52d37d38 (and parent mars-bfa0b177)

Both context-gathering tasks descend from PRD `c6f65902-per-worker-runtime-field-headless-tmux-f` slice 2/5
(**"Workers carry Runtime and tags; dispatcher routes by tag match with headless fallback"**).

The implementor stalled because the slice's premise conflicts with the current
Worker model in non-obvious ways. The slice as written cannot be implemented
"as the thinnest vertical path" — the existing concepts must be either
extended or replaced first.

## Concrete mismatches between the PRD slice and current code

Existing state at `orchestrator/src/mastra/workers/index.ts` + `orchestrator/src/mastra/queue.ts`:

1. **A `Worker` is a named role pinned in source code**, not an
   operator-declared instance.

   - `WorkerName = 'Coder' | 'Planner' | 'Slicer' | 'Triager' | 'Fixer' | 'Writer'`
   - `WORKER_CONFIGS: Readonly<Record<WorkerName, WorkerConfig>>` — keyed by role
   - Configs (model, effort, denials, timeout, maxMessages) baked into
     `index.ts`.
   - No persistence layer for Workers — `.mars/state.db` / `queue.db` do not
     carry a `workers` table.

   PRD demands: **"A Worker can be declared with a Runtime value and a list
   of tags, persisted across orchestrator restarts."** That implies a
   `workers` table (or a per-repo config file), and a runtime registry
   loaded from it — neither exists.

2. **`TaskTag` is a closed enum, single-valued, and 1:1 with a role.**

   - `export type TaskTag = 'coder' | 'writer'`
   - Tasks carry a single `tag?: TaskTag` field (not a list).
   - `getWorkerForTag(tag): Worker` maps tag → named role via a hardcoded
     `TAG_TO_WORKER` record.

   PRD demands:
   - **"A Task can be enqueued carrying a list of tags."** → `tag?: TaskTag`
     becomes `tags?: string[]` (or similar). DB column changes from
     `task.tag TEXT` to `task.tags TEXT` (JSON array) or a `task_tags`
     junction.
   - **"Tags intersect."** → routing logic moves from a `Record` lookup to
     a set-intersection over the (now-declared) Worker pool.
   - **"Free-form"** (per PRD notes: defaulted to free-form for v1) → the
     `TaskTag` union + `isTaskTag` guard must be relaxed to `string`.

3. **There is no "default headless Worker" today.**

   The PRD's fallback rule (untagged Task or no tag match → default
   headless Worker) needs a designated headless instance. Today the Coder
   role is the closest analogue, but it's not declared, doesn't carry a
   Runtime field, and is selected by tag value `'coder'`, not by routing
   fallback. Picking one of the existing roles to be "the default headless
   Worker" is an architectural decision that needs a call (the PRD
   defaults to Coder semantically; this should be confirmed).

4. **No `Runtime` concept exists at all.**

   `WorkerConfig` has no `runtime` field; `runClaudeCode` always runs
   headlessly. Slice 2 only needs the field to exist and default to
   `'headless'` — actual tmux execution is later slices — but the field
   has to land on `WorkerConfig` (and persist) before tagging makes sense.

## Why slice 2 is not a clean tracer bullet on top of this

A tracer bullet should "implement the thinnest path through every layer."
Here every layer needs new shape, not a thin pass-through:

- **Schema layer:** new `workers` table OR a config file + loader; `task`
  table column rename `tag → tags` and JSON serialisation.
- **Type layer:** `TaskTag` relaxed from enum to `string`; `Task.tag`
  becomes `Task.tags?: string[]`; `WorkerConfig` gains `runtime` and `tags`.
- **Registry layer:** `Workers` flips from a static `Record<WorkerName, …>`
  to a dynamic registry sourced from persisted declarations; `getWorker`
  / `getWorkerForTag` are replaced by `pickWorkerForTask(tags)` doing
  set-intersection with a documented "headless fallback" rule.
- **Dispatch layer:** every call site of `getWorkerForTag(task.tag ?? 'coder')`
  in the implement workflow swaps to the new picker.
- **Persistence migration:** existing rows with `tag='coder'` and `tag='writer'`
  must round-trip without behaviour change.

Each of these is a slice's worth of work on its own. Bundling them into
one tracer-bullet slice is the reason the implementor read five files
without committing — there is no minimal edit that lands all six
acceptance criteria together.

## Recommended next steps (filed as Mars ideas)

The PRD slice should be re-sliced into smaller hard cuts before another
implementor is dispatched. Suggested cuts (filed below):

1. Add a `runtime: 'headless'` field to `WorkerConfig` (default value
   only, no behaviour change) — proves the field can land without
   breaking anything.
2. Relax `TaskTag` from closed union to free-form `string`; update DB
   serialisation, keep `'coder'`/`'writer'` semantics.
3. Migrate `Task.tag` (singular) to `Task.tags` (list); update `mars task
   add` to accept repeatable `--tag`; preserve existing row routing.
4. Introduce a runtime Worker registry sourced from a persisted
   declaration (table or config), with the existing role configs seeded
   as the initial declarations.
5. Replace `getWorkerForTag(tag)` with `pickWorkerForTags(tags)` doing
   tag-intersection with documented headless-Coder fallback.
6. Add `Worker.tags` (free-form list) and wire declaration into `mars
   worker add` (or equivalent) so operators can configure beyond the
   seeded set.

Only after 1–6 land is "slice 2" of the PRD actually a tracer bullet.

## What is NOT recommended

- Do not attempt to land all six acceptance criteria in one commit on the
  current task — that's exactly what stalled the implementor.
- Do not introduce a parallel `OperatorWorker` concept next to the
  existing role `Worker` — the PRD explicitly unifies them (every Worker
  carries a Runtime), and a parallel concept would have to be unified
  later anyway, violating the "no backwards-compat shims" rule in
  `CLAUDE.md`.

## Read trail recap

- `orchestrator/src/mastra/workers/index.ts` — current registry, lines 14–227.
- `orchestrator/src/mastra/workers/__tests__/registry.test.ts` — behaviour
  tests against `WORKER_CONFIGS`, `getWorkerForTag`.
- `orchestrator/src/mastra/queue.ts:51` — `TaskTag = 'coder' | 'writer'`.
- `orchestrator/src/mastra/queue.ts:139–144` — `Task.tag?: TaskTag` (singular).
- `orchestrator/src/mastra/queue.ts:695, 802` — default-to-`'coder'` boundary.
