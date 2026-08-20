# One typed event emitter and one retention policy for the audit trail

# One typed event emitter and one retention policy for the audit trail

## Status
Accepted

## Context
Task history is split across three stores with different vocabularies and
opposite lifetimes: the transactional bus (`events`, 39 zod-typed kinds,
grows unbounded, no HTTP endpoint), `trace_events` (18 kinds, not
transactional with state, pruned at ~30 days / 50k rows, served by
`GET /events`), and transcripts (bridged to the bus only by a
`contentLength` ping). Four kinds (`task_failed`, `task_blocked`,
`recovery_spawned`, `origin_created`) exist in both event stores with
different payload shapes and no shared type; `core/queue.ts` bypasses the
trace store with raw SQL. No single query can reconstruct a task's history,
and half the trail self-destructs while the other half never does. This
defeats the product requirement that every module's behaviour is traceable
and auditable.

## Decision
There is one typed event emit surface and one retention policy. Bus events
and trace events unify behind a single zod-typed emitter (transactional with
state writes where a state write exists); the duplicate kinds collapse to
one payload shape each; the raw-SQL bypass is removed; retention is a single
declared policy applied uniformly. A task's full history is reconstructable
from this one surface plus transcripts, via one query path.

## Consequences
- `GET /events` serves the unified store; the bus stops being HTTP-invisible.
- SSE/UI invalidation derives from event subscribers instead of the 76
  hand-placed `.broadcast()` calls.
- Hard cut: the old `trace_events` vocabulary and writer paths are deleted in
  the same change, per project policy (code-level; historical rows may be
  migrated once).
- Anything audit-relevant currently living only in ephemeral traces (verify
  output, model attribution) moves onto the durable surface.
