# The Arc aggregate root is the sole writer of task/arc state; no stranded entity by construction

## Status

Proposed (DDD restructure strategy; implemented by the restructure workflow).

## Context

Task/arc writes are scattered across many free functions in `queue.ts`
(`enqueueTask`, `updateTask`, `dropTask`, `addBlockers`, `removeBlocker`,
`insertReflectionTask`) and `queue-fix-tasks.ts` (`upsertFixTask`,
`attachToExistingFixTask`), plus `enqueueFollowUpOnce`. Each guards invariants
locally (`assertTaskKindInvariant`, `assertNotRecoveryEdge`), but there is no
single owner. The result is **stranded entities**: tasks that exist with
`origin_id = self` and no reachable arc (e.g. `MARS-21175626`, a
context-exhausted follow-up whose parent reference lived only in prompt prose).
ADR-0049/0050/0051 each closed one leak; the structural problem — many writers,
no aggregate root — remains, so every new mutation is one more place a leak can
appear.

ADR-0021 already keeps the raw libsql client unexported behind the
TaskStore/StateStore seams, but those facades are thin pass-throughs that do not
own the invariant.

## Decision

Introduce an **Arc aggregate root** as the single thing permitted to create or
mutate task/arc state. The existing free functions become **private members** of
that aggregate; no other module may `INSERT INTO tasks`.

- `Arc.createOrigin(spec)` replaces the origin path of `enqueueTask`
  (`origin_id = id`, `kind='task'`).
- `Arc.addContinuation(spec, { inheritArc })` replaces `--blocked-by`
  follow-ups and `enqueueFollowUpOnce` (inherits the resolved `origin_id`).
- `Arc.spawnRecovery(failed, kind)` replaces `upsertFixTask` /
  `attachToExistingFixTask` (by-construction origin edge, leaf rule).
- `Arc.transition(action, to)` is the one status funnel (wraps `updateTask`).
- `Arc.addBlocker` / `removeBlocker` / `drop` / `status` round out the surface.

Every write path runs a private **`assertArcInvariant(action)`**: *every Action
is attached to an Arc; every Arc has an origin Action*. The invariant is an
application-level construction guard — the DB columns stay nullable-with-default
(no schema rewrite required); the TypeScript boundary makes the aggregate the
only writer.

Enforcement is doubled by an **arch-test build-guard**: any `INSERT INTO tasks`
(or equivalent store write) outside the Arc aggregate module fails the build.

This invariant is enforced **forward only** — see ADR-0056 (no historical
backfill of pre-existing orphans).

## Consequences

- One place owns "what it means to create work"; new mutations cannot strand
  entities without going through (and tripping) `assertArcInvariant`.
- ADR-0021 is extended: the raw client stays unexported *and* the store facades
  are no longer the write surface — the Arc aggregate is.
- ADR-0040/0049/0050/0051 invariants move from scattered guards into aggregate
  methods (single point of enforcement), without changing their semantics.
- The blast radius is wide; the restructure slices by bounded context and
  verifies behaviour parity per slice. `updateTask` survives as the transition
  primitive *inside* the aggregate.
