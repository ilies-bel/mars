# Note: scoping for mars-f8c802eb (events-feed scaffolding, slice 1/3)

This note exists to unblock the implementor for **mars-f8c802eb**, which
was aborted with `too_hard:no-action-after-reads` after 5 reads
(`queue-fix-tasks.ts`, `inbox.test.ts`, `inbox-watch.tsx`,
`init/databases.ts`, `cli.ts`) without taking an action. The brief is
implementable as written; the read trail tells us the implementor stalled
on two design forks that this note resolves.

## What the prompt asks for

Slice 1/3 of PRD `e4415799-inbox-alert-for-stale-unmerged-worktrees`:
add a harness-weakness **Events feed** to the inbox listing so the
operator notices when the orchestrator papered over a failure by
enqueuing a recovery task. Lifecycle: `new` → `acknowledged` → `resolved`
(resolved drops off the visible feed but stays in storage). Events are
stored in an **existing** Mars datastore (no new `.db` file).

## The two forks the implementor stalled on

### Fork A — storage shape

> "Events are stored in an existing Mars datastore (no new database file
> introduced)."

Two readings:

1. Reuse `inbox_items` with a discriminator (e.g. `category='events'`).
2. Add a **new table** to `state.db` (the same SQLite file that already
   holds `inbox_items` and `inbox_history`). This is still an "existing
   datastore" — no new `.db` file appears.

**Pick (2).** Reasons:

- Events have a different lifecycle (`new | acknowledged | resolved`)
  from inbox items (`open | acknowledged | resolved | dismissed`).
  Sharing the table forces a leaky state union and confuses every
  existing inbox query.
- Acceptance criterion "Events section header even when empty" is
  trivial when events have their own list; with a discriminator you
  have to thread an "is-event" filter through every inbox listing call
  site.
- Resolved events drop off the visible feed but stay queryable — that
  is exactly the storage-vs-display split the existing inbox table
  already complicates with its `state='resolved'` rows.

Concretely: new file `orchestrator/src/mastra/lib/events.ts` modelled on
`inbox.ts`, exposing `initEvents`, `emitEvent`, `listEvents`,
`getEvent`, `setEventState`. Use `resolveContext().stateDbPath` so it
lands in the same SQLite file as `inbox_items`. Wire `initEvents()` into
`orchestrator/src/init/databases.ts` alongside `initInbox()`.

Suggested minimum table:

```sql
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- e.g. 'recovery-enqueued'
  state TEXT NOT NULL DEFAULT 'new',  -- 'new' | 'acknowledged' | 'resolved'
  source_task_id TEXT,                -- originating task (for recovery-enqueued)
  fix_task_id TEXT,                   -- the recovery task that was created
  reason TEXT NOT NULL DEFAULT '',    -- short human-readable reason
  payload TEXT NOT NULL DEFAULT '{}', -- JSON for richer context
  emitted_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_state ON events(state);
```

Lifecycle invariant: a row in `state='resolved'` is hidden from
`listEvents()` (the visible feed). The acceptance test
"resolved-hidden-from-feed" verifies this; the test that "resolved
events are still retrievable from storage" reads the row directly with
the raw client (mirror the pattern in `inbox.test.ts` line 220 —
"after resolving an item, raising the same fingerprint creates a new
open item").

### Fork B — emission point

The recovery-enqueue site is `upsertFixTask` in
`orchestrator/src/mastra/queue-fix-tasks.ts`. **Emit exactly one event
in the `created: true` branch — not in the `existing fix-task` reuse
branch.** Acceptance criterion "exactly one new event row" depends on
this. The relevant block is the one that returns
`{ fixTaskId, created: true }` at the bottom of `upsertFixTask` (after
the transaction commits, before the `internalBus().emit('task.blocked',
…)` call is fine — emit the event right alongside that bus emit).

Event payload should carry, at minimum:

- `source_task_id`: `input.sourceTaskId`
- `fix_task_id`: `fixTaskId`
- `reason`: `${input.failingStep}: <short slice of truncated error>` or
  the failure signature — pick something stable; the failure signature
  is the obvious choice (`input.failureSignature`).

Do **not** emit from `spawnInvestigatorAndRaiseInbox` for this slice —
that path raises a `no-recipe` inbox item and is conceptually different
(the orchestrator did NOT paper over anything; it asked for human
attention explicitly). The PRD parent may broaden this later; slice 1
is just the recovery-enqueue case.

## CLI surface

The brief asks for "a CLI verb" for ack and "another CLI verb" for
resolve. The inbox already owns the `ack`/`resolve`/`dismiss` verbs, so
do **not** overload them. Introduce a sibling `events` subcommand in
`orchestrator/src/cli.ts`:

```
mars events                          alias for 'mars events list'
mars events list                     list events in 'new' or 'acknowledged' state
mars events ack <id>                 transition new -> acknowledged
mars events resolve <id>             transition to resolved (hidden from feed)
```

The "Events section header in the inbox listing" requirement is
satisfied by extending `printList` and `printLean` in `cli.ts` (the
`cmd === 'inbox'` block, around line 2332 / 2432). After printing the
inbox rows and the drafts, print:

```
events (<n>):
  <id-short>  <state>  <kind>  <reason>
```

…and when `n === 0`, still print the header line `events (0):`. The
acceptance criterion "Events section header even when empty" is what
locks this in — do not gate the header on `n > 0`.

## Verification

The brief's verify command (`cd orchestrator && npm test events` plus
`npm run build`) should cover:

- `events.test.ts` mirrors `inbox.test.ts` structure: `setupRepo`,
  `loadModule`, per-test isolation via `vi.resetModules()`.
- Cases (one per acceptance bullet):
  - `emitEvent` inserts a row in `state='new'`.
  - `listEvents` returns new + acknowledged but **not** resolved.
  - `setEventState(id, 'acknowledged')` flips state, row still listed.
  - `setEventState(id, 'resolved')` flips state, row hidden from
    `listEvents()`, still retrievable via a direct SELECT against the
    raw client (mirror the inbox test's pattern of reading state.db
    directly).
  - An integration-style test for `upsertFixTask` in the `created:
    true` branch that asserts exactly one new event row appears.

## File-level orientation

- New module: `orchestrator/src/mastra/lib/events.ts`
- New test: `orchestrator/src/mastra/lib/events.test.ts`
- Wire init: `orchestrator/src/init/databases.ts` (add
  `await initEvents()` after `initInbox()`)
- Emit site: `orchestrator/src/mastra/queue-fix-tasks.ts` —
  `upsertFixTask`, the `created: true` branch (the block that ends
  with `return { fixTaskId, created: true }`).
- CLI: `orchestrator/src/cli.ts` —
  - add the new `cmd === 'events'` block near the existing
    `cmd === 'inbox'` block (≈ line 2317);
  - extend `printList` / `printLean` inside the inbox block to render
    the Events section header even when empty.
- Help text: update the usage block at line 271 onwards to document
  the new `events` subcommand and note the new "events" section in
  `inbox list`.

## What is **out of scope** for this slice

- The Ink TUI (`orchestrator/src/cli/inbox-watch.tsx`) — slice 1 only
  needs the plain-text CLI listing. The TUI is a separate code path and
  doesn't appear in the acceptance criteria.
- Stale-unmerged-worktree detection (that's a later slice in the PRD).
- Any new event kinds beyond `recovery-enqueued`.
- Dedup / fingerprinting (inbox has it; the brief doesn't ask for it
  here, and adding it would couple us to a `signature` shape we can't
  defend yet — leave it for a later slice if the operator finds the
  feed noisy).

Keep it tracer-thin. Slices 2 and 3 will thicken.
