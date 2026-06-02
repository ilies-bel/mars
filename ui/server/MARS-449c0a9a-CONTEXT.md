# Context for mars-449c0a9a — Inbox API rewrite, not green-field add

**Task:** mars-449c0a9a — *Inbox API endpoint with source aggregation and
filter* (Slice 1 of 8 for PRD
`1d4d2e62-add-an-events-view-and-an-inbox-view-to`).

The previous implementor run was aborted under `too_hard:no-action-after-reads`
because the read trail uncovered a **premise conflict** between the slice's
acceptance criteria and what already exists on `main`. This note resolves
the conflict so the next dispatch can act.

## The conflict

There is already an `/api/inbox` route, helper, and test suite on `main`,
landed by a sibling slice (see `ui/server/MARS-269ad0a1-CONTEXT.md` for
that arc). Their shape and semantics do not match this slice:

| dimension                | existing on `main`                    | slice 1 requires                                                  |
| ------------------------ | ------------------------------------- | ----------------------------------------------------------------- |
| response body            | `{ drafts, blocked, failed }` (groups)| flat array; each item carries `source: 'draft'\|'blocked'\|'failed'` |
| `failed` source          | tasks where `status = 'failed'`       | tasks where `status = 'dropped'` (post-retry-budget)              |
| source filter            | none                                  | optional `?source=draft\|blocked\|failed` query param              |
| `task_suggestions` table | not surfaced (correct, keep)          | not surfaced (must remain so)                                     |

The status semantics matter: in this repo `failed` is a transient
attempt-level state inside the retry budget and `dropped` is the terminal
"give up" state — see `orchestrator/src/core/queue.ts` and
`queue-retry.ts`. The slice's "items needing review" definition is the
terminal one (`dropped`), not the transient one (`failed`).

No UI code currently consumes `/api/inbox` (grep `ui/src` returns no
matches), so the rewrite is safe to land as a hard cut.

## What the next implementor should do

Per `CLAUDE.md` ("Every change is a hard cut. No backwards-compat shims"),
**replace the existing endpoint in place** rather than adding a parallel
route. Touch only these files:

1. `ui/server/inbox.ts`
   - Drop `InboxData` (`{ drafts, blocked, failed }`) and replace
     `aggregateInbox` with a function that returns `InboxItem[]`, where
     `InboxItem = { source: 'draft' | 'blocked' | 'failed', ...payload }`.
   - The `failed` source must pull `db.listTasksByStatus(['dropped'])`,
     **not** `['failed']`. Keep the `tableExists()` / `ideasTableExists()`
     guards so a fresh repo returns `[]`.
   - Accept an optional `source` filter argument; when set, query only
     that one source.

2. `ui/server/index.ts`
   - Update the `/api/inbox` handler to parse `url.searchParams.get('source')`,
     validate it against the three allowed values (reject others with 400
     or treat as "no filter" — pick the stricter option and note it in
     the commit), pass it through, and respond with the flat array
     directly (not wrapped under a key, per the acceptance criteria
     "returns items … in one array").

3. `ui/server/inbox.test.ts`
   - Rewrite to the new shape. Tests should be regrouped against the
     eight acceptance bullets:
     - empty repo → `200` + `[]`
     - all three sources populated → one array, each item tagged
     - `?source=draft|blocked|failed` → only that source's items
     - draft items match ideas where `status='draft'`
     - blocked items match tasks where `status='blocked'`
     - failed items match tasks where `status='dropped'` (insert a
       `dropped` task and a `failed` task in the fixture; assert only
       the `dropped` one appears)
     - never surface `task_suggestions` (insert a row in that table and
       assert it doesn't leak; create the table inline in the fixture
       since the production schema may or may not have it)

## Out of scope for this slice

- Do not touch `ui/server/events.ts` / `events.test.ts` — that's slice 2,
  already complete on `main`.
- Do not build any React UI — that's a later slice.
- Do not modify orchestrator status semantics — `failed` vs `dropped` is
  already correct upstream.

## Verify

```
cd ui && npm test -- inbox
```

All cases should be green before committing. The orchestrator does not
commit on the agent's behalf.
