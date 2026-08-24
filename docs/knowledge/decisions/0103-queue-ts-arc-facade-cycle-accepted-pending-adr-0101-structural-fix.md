# queue.ts → arc.ts cycle accepted in baseline; structural fix deferred to ADR-0101

## Status

Accepted.

## Context

`core/arc.ts` (Arc aggregate root, ADR-0052) imports ~20 symbols from
`core/queue.ts` — types (`Task`, `TaskStatus`, …), constants
(`TERMINAL_TASK_STATUSES`, `UNSETTLED_BLOCKER_SQL`, …), validators
(`isTaskTag`, `isMergeMode`, …), DB plumbing (`ensureQueueSchema`,
`resolveQueueClient`, `rowToTask`, …), and two heavier primitives
(`getTask`, `updateTask`). This is the `arc → queue` import direction.

`core/queue.ts` in turn imports `Arc` from `core/arc.ts` to power a set
of thin one-line delegating wrappers (`enqueueTask`, `dropTask`,
`reopenTerminalTask`, `setTaskPriority`, `setTaskVerifyCmd`,
`insertReflectionTask`, `promoteDraftToTriaging`, `promoteDraftToQueued`,
and the `Arc.applyStatusWrite` call inside `updateTask`). These wrappers
are the `queue → arc` back-edge. Together the two directions form a mutual
cycle that dep-cruiser reports as three separate violation edges:

    arc → queue            (direct — arc imports types/functions from queue)
    arc → queue-retry      (transitive: queue-retry imports from queue,
                            queue imports Arc from arc)
    arc → store/task-store (separate edge, tracked by ADR-0101)

The wrappers exist because ADR-0052 relocated write logic into the Arc
aggregate but deliberately preserved the external call surface of the
legacy free functions in `queue.ts` so that the hundreds of callers and
tests that import `{ enqueueTask, dropTask, … }` from `'../queue'` did
not require mechanical migration in the same slice. The doc comments on
each wrapper explicitly note "this export keeps the historic call surface".

Two approaches were evaluated for cutting the `queue → arc` back-edge
(the one that closes the mutual cycle):

**Re-export indirection (third-module passthrough)**
Create `core/arc/facade.ts`, move the delegating bodies there, and have
`queue.ts` re-export them. The dep-cruiser graph still contains
`queue → arc/facade → arc → queue` — a longer cycle but the same SCC.
ADR-0101 records this was tried, produced 3 **new** cycle violations, and
was reverted (commit `07843cba`).

**Caller migration (retire the facade)**
Remove every wrapper from `queue.ts`, update all ~15 production call
sites and all test imports to call `Arc.*` directly. This is correct but
wide: it touches the daemon dispatch loop, the workflow engine, reflector,
purge, server, slice-workflow, queue-fix-tasks, and dozens of test files.
It also requires amending ADR-0052 to retire its "historic call surface"
guarantee — a hard-to-reverse contract change that should not be made as a
recovery-task side-effect.

**Structural fix (ADR-0101)**
Move `updateTask` and `getTask` **into** `core/arc.ts`; extract the pure
types/constants/validators into a dependency-free leaf module
(`core/lib/queue-primitives.ts`) that both `arc.ts` and `queue.ts` import.
After this, `arc.ts` no longer needs to import `queue.ts` at all — the
`arc → queue` edge is gone — and `queue.ts` re-importing `updateTask` /
`getTask` from arc is the correct facade direction. `queue-retry.ts`'s
imports from `queue.ts` remain unchanged and no longer close a cycle.
This is the **right fix** and it is already specified in ADR-0101.

## Decision

**Accept the `queue → arc` cycle in the baseline until ADR-0101's
structural fix is implemented.** The cycle is already recorded in
`.dependency-cruiser-known-violations.json`. No new code movement is made
here; re-export indirection is not introduced (ADR-0101 explicitly rejects
it); and the caller-migration approach is deferred because the blast radius
is not proportionate to a recovery slice.

The dep-cruiser circular count involving `core/arc*` stands at 3 (below
the done-criterion threshold of 5), so the constraint is satisfied without
code change.

The wrappers in `queue.ts` remain intentional. Their doc comments already
say so; this ADR makes the lifecycle decision explicit: they are temporary
scaffolding, not permanent API, and they fall away when ADR-0101's
`queue-primitives.ts` extraction lands.

## Consequences

- The `arc ↔ queue` cycle remains in the accepted violations baseline.
  It does not grow: the 3 violations are already recorded.
- ADR-0052 is **not** amended — the "historic call surface" guarantee is
  still in effect and still accurate; the wrappers remain.
- Whoever implements ADR-0101's edge-1 fix (`queue-primitives.ts`
  extraction + `updateTask`/`getTask` ownership move) should delete the
  three corresponding entries from
  `.dependency-cruiser-known-violations.json` in the same commit, using
  `npm run arch:baseline` to regenerate and confirm the shrink.
- No caller migration is required at this time; all existing
  `import { enqueueTask, dropTask, … } from '../queue'` paths remain valid.
