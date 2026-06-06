# Alert is an arc-rooted read aggregate: goal → plain-English reason → technical drill-down; clears only by mutating its entity

## Status

Proposed (DDD restructure strategy). Extends ADR-0048 and ADR-0051.

## Context

ADR-0048 made the action queue a pure projection of entity state with no
operator close verbs; ADR-0051 keyed each row on the resolved `origin_id` so a
failing arc surfaces as one row. But the row is still **flat**: failure detail,
goal, and reason are fields on one record, and `buildActionQueueView` enriches
rows imperatively. The user's requirement is sharper: *"an alert should
aggregate a full failed arc and expose the information in a hierarchy relevant to
the user — the goal of the original task, a clear English message of why it
failed, then more technical details after."* And: *"an alert cannot be dismissed;
the only way to not show it is to mutate the underlying entity."*

## Decision

Promote **Alert** to a first-class **arc-rooted read aggregate**, derived from an
Arc plus its `FailureKind`. It is never stored as a mutable row; it is computed
on demand and presents a fixed hierarchy:

```
Alert {
  arcId       // resolved origin_id (ADR-0051)
  goal        // origin Action's intent, plain summary
  reason      // FailureKind.humanReason — clear English, no jargon
  technical { // drill-down, deeper in the hierarchy
    failedAction { id, kind, worktree }
    signature   // failure signature
    traceTail   // bounded tail of trace events
    descendants // fix/diagnose attempts
  }
  clearsBy: 'mutate the underlying entity'
}
```

- An Alert **clears only** when its Arc reaches a terminal-resolved state or its
  worktree is removed. There is no dismiss/ack/resolve gesture (ADR-0048
  upheld). The residual `/view/todo/dismiss` daemon endpoint is **cut** as part
  of this work.
- Alerts are always **attached to an entity** (a failed/blocked Arc, or a stale
  worktree). An Alert with no backing entity cannot exist — the projection
  produces it iff the entity is stuck.
- The Alert aggregate lives in the domain layer and is exposed through the
  application-service layer (ADR-0055); CLI/UI/TUI/skills render the same
  hierarchy.

## Consequences

- The Action Queue is `alerts() + drafts()`: everything needing a human.
- New CLI surface: `mars alert list` / `mars alert show <id>` render the
  arc-rooted hierarchy; the existing `mars action-queue` list shows alerts +
  drafts.
- One alert per arc is preserved (ADR-0051); a failed recovery's own detail is
  carried as `technical.descendants`, not a second alert.
- The "operator hushes a failure" affordance remains gone (ADR-0048's
  trade-off); a re-failed arc re-derives its Alert, which is correct under a
  projection.
- `buildActionQueueView` becomes a thin renderer over the Alert/Draft
  aggregates rather than the place enrichment logic lives.
