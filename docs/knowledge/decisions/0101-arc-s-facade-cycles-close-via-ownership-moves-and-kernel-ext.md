# arc's facade cycles close via ownership moves and kernel extraction, never re-export indirection

## Status

Proposed.

## Context

`core/arc.ts` is the Arc aggregate root (ADR-0052): the sole writer of
`tasks`/`task_blockers` state, enforced by an arch-test guard
(`arc-sole-writer.test.ts`, `ALLOWLIST = ['core/arc.ts', 'core/arc/recovery.ts']`
— no other file may `INSERT`/`UPDATE (any column)`/`DELETE` those tables).
`core/queue.ts` and `core/store/task-store.ts` were converted into thin
facades that delegate their write verbs to it (`Arc.createOrigin`,
`Arc.load(id).drop()`, `Arc.load(id).addBlocker(...)`, `setReviewPacket`,
`setQaReport`, …) — the correct direction per ADR-0052.

Measured directly against `.dependency-cruiser-known-violations.json` today:
169 accepted violations, 18 import cycles, of which 7 involve the
`queue.ts`↔`arc.ts` edge, 5 involve `store/task-store.ts`↔`arc.ts`, and 4
involve `queue-retry.ts`↔`arc.ts` (`arc.ts` appears in most of the 18). The
recovery-concern split (commit `950d72af` and predecessors) already cut this
from 176/25, and left a comment on `arc.ts` (line ~252) naming exactly these
three edges as the deferred remainder — this ADR is that follow-up.

Each edge has a distinct cause; the fix is not the same shape for all three:

1. **`arc.ts -> queue.ts` (~20 symbols, 7 cycles).** `arc.ts` imports types
   (`Task`, `TaskStatus`, `TaskKind`, …), constants (`MERGE_MODES`,
   `TASK_SEL`, `TERMINAL_TASK_STATUSES`, `UNSETTLED_BLOCKER_SQL`),
   validators (`isTaskTag`, `isMergeMode`, `coerceToString`,
   `validatePriority`), plumbing (`rowToTask`, `assertTaskKindInvariant`,
   `ensureQueueSchema`, `resolveQueueClient`, `IllegalTransitionError`), and
   two heavier functions (`getTask`, `updateTask`) from `queue.ts`, while
   `queue.ts` imports `Arc` for its facade verbs. Inspecting `updateTask`
   specifically: its own doc comment on the `arc.ts` call sites (line ~953)
   already calls it "the transition primitive that survives *inside* the
   aggregate" — the code already treats it as Arc's, it just isn't
   physically there.

2. **`store/task-store.ts -> arc.ts` (5 cycles).** `task-store.ts`'s
   `createTaskStore()` legitimately depends on `Arc` (ADR-0052: the facade
   is inverted onto the aggregate) for 3 of its ~25 methods (`dropTask`,
   `addBlockers`/`removeBlocker`, `insertReflectionTask`, …). The cycle
   exists only because `arc.ts` also imports the `DomainTaskStore` *type*
   and the memoised singleton accessors `getDefaultTaskStore`/
   `getDefaultDomainTaskStore` from the same file, as its injected
   persistence seam.

3. **`queue-retry.ts <-> arc.ts` (4 cycles, genuine mutual recursion).**
   `arc.ts` statically imports `markTaskFailed` from `queue-retry.ts`
   (several orphan/stranded-origin paths call it). `markTaskFailed` in turn
   dynamically imports `Arc` to call `Arc.blockByTaskFailure(taskId)`
   best-effort, wrapped in try/catch, immediately after the same
   `updateTask` call already durably emits a `task.terminal
   { reason: 'failed' }` outbox event in the same transaction (`queue.ts`
   ~1542). This is real recursion, not an accident.

Two shapes were on the table (see the task prompt for the original framing):
"facade-owns-aggregate" (arc.ts stops importing queue.ts, wide change) vs.
"invert through the outbox" (works for #3, less obviously for #1/#2). Having
now traced each edge to its actual cause, they are not competing
alternatives — they are the right tool for different edges.

**Anti-pattern already tried and reverted (commit `07843cba`):** re-exporting
a needed symbol through a third module (e.g. `arc.ts` importing
`markTaskFailed` from `blocker-resolution.ts` instead of `queue-retry.ts`)
does not remove a cycle, it lengthens it — `npm run arch` reported 3 *new*
cycles. Nothing below does this: every move below changes which file
*defines* a symbol, or removes a call entirely — never adds a passthrough
re-export to dodge an edge.

## Decision

Close all three edges, each with the mechanism that matches its cause:

**1. `arc.ts -> queue.ts` — split by ownership, not by indirection.**

- `updateTask` (and `getTask`, on the same audit) move *into* `core/arc.ts`
  (or a private `core/arc/`-scoped module) — finishing the move their own
  doc comments already claim happened. `queue.ts` then imports them back
  for its own external-facing wrappers (`queueUpdateTask`, etc.), which is
  the correct facade direction and matches how `setTaskStatus`'s raw
  `UPDATE tasks SET status` already made this exact move in ADR-0052's
  original restructure. This keeps every raw task-table write inside the
  `arc-sole-writer.test.ts` allowlist without touching that guard.
- The remaining symbols — types, `MERGE_MODES`, `TASK_SEL`,
  `TERMINAL_TASK_STATUSES`, `UNSETTLED_BLOCKER_SQL`, `isTaskTag`,
  `isMergeMode`, `coerceToString`, `validatePriority`, `rowToTask`,
  `assertTaskKindInvariant`, `ensureQueueSchema`, `resolveQueueClient`,
  `IllegalTransitionError` — have no directional ownership story; they are
  pure data/validation with no writes. Extract them into a new dependency-
  free leaf module (e.g. `core/lib/queue-primitives.ts`) that both
  `arc.ts` and `queue.ts` import. This is dependency-cruiser's own
  prescribed remedy for this rule (`.dependency-cruiser.cjs` comment on
  `no-circular`: "Break the cycle by extracting the shared thing into a
  leaf module, or by inverting the dependency behind an interface.").
  None of these symbols write `tasks`/`task_blockers`, so the leaf module
  needs no allowlist entry.
- The implementation slice must audit each of `arc.ts`'s current
  `updateTask(...)` call sites (lines ~361, ~988, ~1024, ~1089 today):
  some may already be a redundant round-trip (arc.ts calling queue.ts's
  wrapper around what is, after the move above, arc.ts's own primitive)
  and should become a direct internal call instead of an import at all.

**2. `store/task-store.ts -> arc.ts` — extract the shared seam contract.**

Move the `DomainTaskStore` type and the memoised
`getDefaultTaskStore`/`getDefaultDomainTaskStore` singleton accessors out of
`task-store.ts` into a new small leaf module (e.g.
`core/store/task-store-default.ts`) that imports `createTaskStore` from
`task-store.ts` (one-directional: `task-store.ts` still does not need to
know about it). `arc.ts` imports the type and the two accessors from the
new module instead of from `task-store.ts`. `createTaskStore` itself — the
factory whose body legitimately calls `Arc.createOrigin`/`Arc.load(...)`
for its write-verb methods — stays in `task-store.ts`; that direction
(facade → aggregate) is correct and must not move.

As a cheap first check before building the new module: dependency-cruiser's
`no-circular` rule already excludes cycles that exist solely through
type-only edges (`viaOnly: { dependencyTypesNot: ['type-only'] }` in
`.dependency-cruiser.cjs`, because such a cycle "vanishes at compile time").
If, after moving just the two value-level accessor functions out, `arc.ts`'s
remaining need from `task-store.ts` is only the `DomainTaskStore` type,
write that one import as `import type { DomainTaskStore } from
'./store/task-store'` and re-run `npm run arch` — the edge may already be
gone without a second new file.

**3. `queue-retry.ts <-> arc.ts` — delete the call, use the outbox already there.**

Remove the dynamic `await import('./arc')` / `Arc.blockByTaskFailure(taskId)`
call from `markTaskFailed` entirely. `updateTask` already durably emits
`task.terminal { taskId, reason: 'failed' }` in the same transaction as the
status write. `src/outbox/subscribers/blocker-resolution.ts`'s
`drainBlockerResolution` already has a `reason === 'failed'` branch that
calls the sibling cascade `Arc.failStrandedOriginOnRecoveryFailure(taskId)`
on that exact event. Add the `Arc.blockByTaskFailure(taskId)` call
alongside it, in the same branch. `queue-retry.ts` then has zero references
to `Arc`, static or dynamic, and the cycle is gone — no new inversion
mechanism, just consolidating onto the subscriber the diagnose-verdict fix
(commit `950d72af`) already established as the pattern for "Arc reports,
an outbox subscriber outside `core/` acts."

## Consequences

- `Arc.blockByTaskFailure`'s cascade (queued → blocked dependents + one
  action-queue item) moves from synchronous-and-best-effort (errors
  silently swallowed by `markTaskFailed`'s `try/catch`) to outbox-driven
  (same latency class as every other blocker-cascade reaction today, and
  now covered by the ADR-0032 stall contract — a failing cascade raises a
  `subscriber-stalled` action-queue item after K consecutive failures
  instead of vanishing into a caught exception). This is a reliability
  improvement, not just a wash, but it is an observable timing change any
  test asserting synchronous blocking after `markTaskFailed` must account
  for.
- The `arc-sole-writer.test.ts` allowlist (`core/arc.ts`,
  `core/arc/recovery.ts`) does not change — every raw task-table write
  stays inside it. Do not extract `updateTask`/`getTask` to the new
  `core/lib/queue-primitives.ts` leaf module; they belong inside the
  aggregate's own files.
- Two new leaf modules are added (`core/lib/queue-primitives.ts`,
  `core/store/task-store-default.ts`, exact names at the implementor's
  discretion). Both must import nothing from `arc.ts`, `queue.ts`, or
  `task-store.ts` beyond what they're extracting, or the extraction
  recreates the cycle one hop further out — exactly the failure mode of
  the reverted `07843cba` attempt.
- `npm run arch` / `npm run arch:baseline` must be re-run after each of the
  three edges closes; the baseline may only shrink (enforced by the
  ratchet mechanism already in place).

## Implementation notes for the follow-up slice

    npm run arch                 # from the repo root
    npm run arch:baseline        # must SHRINK the baseline, never grow it
    cd orchestrator && npm run typecheck && npm test

Slice in the order above (1, then 2, then 3) or independently — the three
edges do not depend on each other. Re-verify the `arc-sole-writer` test
suite (`orchestrator/src/core/__tests__/arc-sole-writer.test.ts`) after
step 1 specifically, since it is the one step that moves code across the
allowlist boundary (into it, which is safe; moving anything the other way
is the failure mode to watch for).
