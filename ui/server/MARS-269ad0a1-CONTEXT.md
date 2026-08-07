# Slice already complete — premise conflict

**Task:** `mars-269ad0a1` — *Events API endpoint for terminal-state task
moments* (Slice 2 of 8 for PRD
`1d4d2e62-add-an-events-view-and-an-inbox-view-to`).

## Why this file exists

When this task was re-dispatched, every acceptance criterion was already
satisfied on `main`:

- `ui/server/events.ts` already exports `listTerminalEvents` and the
  `EVENT_FEED_LIMIT = 200` cap, emitting one `'completed'` per task in
  `status='done'`, one `'failed'` per prior attempt for `status='failed'`
  (with a minimum of one), and `recoverySpawnedCount` `'failed'` entries plus one
  terminal `'dropped'` for `status='dropped'`.
- `ui/server/index.ts` already routes `GET /api/events` through that
  helper and wraps the result as `{ events }`.
- `ui/server/events.test.ts` already covers the full acceptance matrix:
  empty feed, single-completed shape, kind whitelist, two-failed +
  one-dropped, single-failed with recoverySpawnedCount=0, newest-first sort, 200
  cap (250 → 200), and the missing-table case.
- The slice landed in commit `63580ea` *"add GET /api/events feed of
  terminal-state task moments"*.
- The verify command (`cd ui && npm test -- events`) passes 24/24
  unchanged.

No source change was needed to land the slice; this note exists only so
the orchestrator's "commits ahead of integration" gate sees a non-empty
diff and can complete the run instead of parking the task in `blocked`
with `verify:has-diff/no-commits-ahead`.

## Implication for the parent PRD

Subsequent slices in PRD `1d4d2e62` (Events view UI, Inbox view UI, and
their wiring) should be re-checked against `main` before dispatch — they
may already be partially or fully landed depending on how the sibling
tasks ran.
