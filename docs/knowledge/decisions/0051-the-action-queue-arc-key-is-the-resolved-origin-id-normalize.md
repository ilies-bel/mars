# The action-queue arc key is the resolved origin_id, normalized in the raise path

## Context

ADR-0048 declares the action queue a pure projection of entity state, keyed at
raise time — but it does not say WHICH key. In practice every raiser passes
some task id as `originTaskId`, and `computeOriginFingerprint` hashes it
VERBATIM with no `origin_id` resolution. The result: a fix task, a blocked
slice task, or a stale fix-task worktree each produce an action-queue row keyed
on their OWN id rather than their arc's `origin_id`, so a single failing arc
surfaces as multiple alert rows. The user wants ONE item per arc (origin task
through to done), not one per fix/recovery/follow-up.

## Decision

The action-queue arc key is the RESOLVED `origin_id`, normalized inside the
single raise path (`raiseActionQueueItem`). When a raiser supplies an
`originTaskId`, the raise path resolves it through `resolveOriginIdForTask`
(`origin_id ?? id`) BEFORE computing the fingerprint and before persisting
`origin_task_id`. One-row-per-arc becomes a STRUCTURAL invariant of the
projection, not a per-caller convention each raiser must remember.

- The resolution degrades gracefully: a non-task origin (a bare `proposalId`,
  or any id with no matching task row) passes through unchanged.
- A failed recovery's OWN row is not collapsed away — its detail (which
  worktree, which fix task) is carried as arc descendants/enrichment, while the
  single arc-keyed row is what appears in the alert list.

## Consequences

- This amends/extends ADR-0048: the projection is still pure and raise-time
  keyed, but the key is now canonically the arc origin, resolved in one place.
- Raisers that today leak a non-origin id (the repopulator, inbox task.blocked,
  stale-worktree and daemon-killed sweeps) become correct-by-default once they
  flow through the normalized raise path; the remaining per-raiser fixes are
  about not emitting a SECOND row for the same arc (single-owner), not about
  the key.
- The CLI list (`mars action-queue list`, used by /mars:alerts and
  /mars:action-queue) and the daemon/UI `buildActionQueueView` both render the
  arc-keyed rows; no projection-time GROUP BY is added (rejected — the fix is
  at raise time per this ADR and ADR-0048).
