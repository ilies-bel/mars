# PRD c6f65902 — Slice 2 cannot land as a tracer-bullet

> Captured by mars-3968fee4 (context-gathering for mars-52d37d38, which
> was context-gathering for mars-bfa0b177 — the original Slice 2
> implementor). Two consecutive implementor agents hit
> `too_hard:no-action-after-reads` because the slice as worded does not
> map onto the codebase as it currently stands.

## What Slice 2 says it needs

From PRD `c6f65902-per-worker-runtime-field-headless-tmux-f`, slice 2 of
5 ("Workers carry Runtime and tags; dispatcher routes by tag match with
headless fallback"):

- Add a `Runtime` field (default `'headless'`) and a free-form `tags`
  list to the **Worker** concept, persisted across restarts.
- Add a `tags` list to the **Task** contract.
- Dispatcher picks a Worker by tag intersection; falls back to "the
  default headless Worker" when no Worker matches or the Task has no
  tags.
- `Worker` listing output shows each Worker's `Runtime` and tags.

## Why this is not a thin slice in the current code

The PRD's mental model treats **Worker** as something an operator
declares at runtime (with a Runtime mode and a bag of tags). The
codebase's `Worker` is a different thing entirely:

- `orchestrator/src/core/workers/index.ts` defines `WorkerName` as a
  closed union of six **role** keys (`Coder | Planner | Slicer |
  Triager | Fixer | Writer`).
- Each is a hardcoded `WorkerConfig` (model, effort, permission mode,
  bare flag, denied tools, default timeout, message cap).
- There is no persistence, no operator-facing declaration surface, no
  `mars worker` CLI verb, and no "default headless Worker" — every
  Worker is already headless (`runClaudeCode` / `claude -p`).

Tags are also already in the code, but in a shape that conflicts with
the PRD:

- `queue.ts` defines `TaskTag = 'coder' | 'writer'` — a **controlled
  vocabulary**, not free-form.
- The `TaskSpec` carries a **single** optional `tag`, not a `tags` list.
- `getWorkerForTag(tag)` maps one tag to one Worker role via a
  hardcoded `TAG_TO_WORKER` record; there is no intersection matcher
  and no fallback path because every code path defaults `tag` to
  `'coder'`.

Landing the slice as written requires, at minimum:

1. Deciding what `Worker` means — keep the role registry and overlay a
   separate operator-declarable concept (e.g. `WorkerInstance`,
   `DispatchSlot`), or demote the role registry to default-instances of
   a single broader Worker concept. This is an architectural choice;
   ADR-worthy.
2. Widening `TaskTag` from controlled-vocab single-field to a free-form
   list, and renaming every call site (`queue.ts`, daemon protocol,
   `implement-workflow.ts`, CLI add-task parser, queue-tag tests).
3. Introducing the operator-facing declaration mechanism — persistence
   file (likely `.mars/workers.json`), daemon load path, and `mars
   worker list/add` CLI verbs.
4. Then, finally, the tag-intersection matcher with headless fallback,
   plus the listing output the last acceptance criterion mentions.

Doing any one of those well is itself a slice. Doing all four as the
"thinnest path" Slice 2 cannot succeed.

## Follow-ups filed

Three scoped ideas are now in the backlog (`mars idea list`):

- **b1d586f3** — Redesign `Worker` as operator-declarable (capture
  choice in an ADR before any slice codes).
- **dd212935** — Widen `TaskTag` from a single controlled-vocab field
  to a list of free-form strings (hard-cut rename across all call
  sites).
- **ed2f9744** — Introduce `mars worker list` CLI verb and operator
  Worker declaration mechanism; defer tmux execution to a later slice.

## Recommendation for the orchestrator

Slice 2 of PRD c6f65902 should be re-sliced against the three follow-ups
above (or against an ADR landed first). The current slice 2 prompt
should not be re-dispatched as-is; it will keep tripping the read-span
watcher until the architectural choice in **b1d586f3** is made.
