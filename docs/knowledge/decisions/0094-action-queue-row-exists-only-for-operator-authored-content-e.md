# action-queue row exists only for operator-authored content; every condition is derived

# Context

The action_queue_items table historically stored rows for both:
1. **Condition kinds** — alerts computed from system state (failed tasks, stale queues, broken gates, etc.)
2. **Row-backed kinds** — items carrying operator-authored content (draft proposals, plan approvals, human-parked tasks, etc.)

Evidence of staleness from the pre-0057 action_queue_history:
- The resolution `condition-cleared` appears exactly once across ~12,000 alerts.
- 8318 of 8753 `failed` rows and 171 of 174 `daemon-code-drift` rows closed as `superseded` — a newer identical alert replacing the old one. Churn masquerading as hygiene.
- `steward-repeat` closed 0 of 9 ever; `baseline-broken` closed 0 of 1. High-cardinality kinds accumulate permanently.
- Net: 31 open rows describing conditions that were provably false.

# Decision

**An action-queue row may exist only when it carries content that cannot be recomputed from live state.**

Everything else is a **derived view over live state**, computed on read, never stored.

## Derived kinds (raisers deleted, rows computed on read)

| kind | derived from |
|---|---|
| `failed` | tasks.status = 'failed' |
| `stale-queued` | tasks.status = 'queued' + age threshold |
| `gate-broken` | verify_gates WHERE state='quarantined' |
| `subscriber-stalled` | subscriber_stalls table |
| `signature-storm` | dispatch pause state (reason='storm') |
| `daemon-died` | crash marker file presence |
| `daemon-code-drift` | daemon running sha vs HEAD |
| `baseline-broken` | isBaselinePoisoned() in-memory flag |
| `stale-worktree` | filesystem stat on worktree directories |
| `phantom-task` | task reaches status='failed' via watchdog |
| `worktree-ahead` | worktree has commits ahead of integration branch |
| `orphaned-origin` | task fails at unblock due to missing origin |
| `steward-repeat` | steward ledger + arc status |

## Row-backed kinds (kept, close atomically with mutation)

`draft-proposal`, `plan-approval`, `awaiting-human`, `gate-enrichment`, `scorer-suggested`, `reflect-recommended`

# Consequences

- **No stale alerts.** A condition that no longer holds immediately disappears.
- **Cost per read.** N cheap derivations per listing; measured impact is negligible.
- **Lost history.** seen_count and first-raised timestamps disappear for derived kinds. action_queue_history retains any audit trail needed.
- **Snooze.** No derived kind currently uses snoozed_until. If needed, a side table keyed by deriveId(kind, entityKey) is the correct extension.

# Rejected alternative

A predicate + sweep design (task mars-c41f1ff6) fixes today's stale rows but leaves the same failure mode in place for every kind added later. Derivation makes staleness unrepresentable by construction.
