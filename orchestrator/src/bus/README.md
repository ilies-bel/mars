# bus

Local-first event bus for the Mars orchestrator. Library code publishes events
atomically with the state writes they describe, into an `events` outbox table.
Consumers are in-process subscribers that poll that table and advance their own
cursor.

## Architecture

```
Writers (queue.ts, action queue.ts, …)
       │ write transaction
       ▼
events table  ──►  subscribers.ts (per-subscriber cursor)  ──►  handlers
                   processed-once.ts (at-most-once side effects)
```

- Writers call `publish(tx, type, payload)` **inside an open write
  transaction** so the event commits atomically with the state row it describes.
- Storage is the orchestrator's Postgres database, reached through the
  `DbClient` abstraction in `src/core/lib/db.ts` — the same connection the rest
  of the orchestrator uses, so transactional atomicity is guaranteed.
- `subscribers.ts` fans events out to registered handlers, tracking a cursor per
  subscriber; `processed-once.ts` guards side effects that must not run twice.

There is no WebSocket transport. A `daemon.ts` / `client.ts` pair once fanned
events out over WebSocket to external clients; both were orphaned (zero
importers) and have been removed. The UI gets its invalidation pings from the
daemon's own `GET /view/stream` SSE channel, not from this module.

## How to add a new event type

1. Add a zod schema entry in `src/bus/events.ts`:
   ```ts
   export const EventMap = {
     ...,
     'task.dropped': z.object({ taskId: z.string(), dropReason: z.string() }),
   } as const;
   ```
2. Publish it from a writer, inside the same write transaction as the state
   change it describes:
   ```ts
   import { buildEventInsert, withWriteTx } from '../bus/publisher.js';

   await withWriteTx(client, async (tx) => {
     await tx.execute({ sql: 'UPDATE tasks SET status = $1 WHERE id = $2', args: ['dropped', taskId] });
     await tx.execute(buildEventInsert('task.dropped', { taskId, dropReason }));
   });
   ```
3. Register a subscriber (see `subscribers.ts`) to react to it.

The publisher and the subscriber registry are both generic over `EventMap` — no
other file needs to change when a new event type is added.

## Non-goals (deliberately omitted)

- Event pruning / retention (rows grow unbounded; a future pass should cap by
  age or per-subscriber cursor; see `queue.ts` TODO comment).
- Distributed deployment across machines.
- Push-based delivery. Subscribers poll; there is no change-notification hook.
