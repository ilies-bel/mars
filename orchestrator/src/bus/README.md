# bus

Local-first event bus for the Mars orchestrator. Library code publishes events
atomically with the state writes they describe via a shared `mars.db` (libsql).
One daemon tails an `events` outbox table and fans events out over WebSocket.

## Architecture

```
Writers (queue.ts, action queue.ts, …)
       │ libsql write transaction
       ▼
mars.db → events table  ──►  Bus Daemon (single poller)  ──►  WebSocket clients
                                                               (UI, agents, browser)
```

- Writers call `publish(tx, type, payload)` **inside an open libsql write
  transaction** so the event commits atomically with the state row it describes.
- The `events` table lives in `mars.db` — same file, same driver — so
  transactional atomicity is guaranteed.
- The daemon (`startDaemon()`) uses the shared `getClient()` singleton from
  `queue.ts` — no second connection.
- The daemon fans events out over WebSocket with per-client topic filtering and
  cursor-based replay.

## How to add a new event type

1. Add a zod schema entry in `src/bus/events.ts`:
   ```ts
   export const EventMap = {
     ...,
     'task.dropped': z.object({ taskId: z.string(), dropReason: z.string() }),
   } as const;
   ```
2. Publish it from a writer, inside a libsql transaction:
   ```ts
   import { publish } from '../bus/publisher.js';
   import { getClient } from './queue.js';

   const tx = await getClient().transaction('write');
   try {
     await tx.execute({ sql: 'UPDATE tasks SET status = ? WHERE id = ?', args: ['dropped', taskId] });
     await publish(tx, 'task.dropped', { taskId, dropReason });
     await tx.commit();
   } catch (err) {
     tx.close();
     throw err;
   }
   ```
3. Subscribe from any client:
   ```ts
   bus.on('task.dropped', ({ taskId, dropReason }) => { ... });
   ```

The publisher, daemon, and client are all generic over `EventMap` — no other
file needs to change when a new event type is added.

## Non-goals (deliberately omitted)

- Authentication / TLS (local-only for now; see `daemon.ts` TODO).
- Event pruning / retention (rows grow unbounded; a future pass should cap by
  age or per-subscriber cursor; see `queue.ts` TODO comment).
- Distributed deployment across machines.
- Replacing `setInterval` polling with a change notification hook (future
  optimization, see `daemon.ts` TODO).
