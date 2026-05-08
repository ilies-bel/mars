# bus

Local-first event bus scaffold for the Mars orchestrator. Multiple processes
read and write a shared SQLite file; one daemon tails an outbox table and
fans events out over WebSocket.

This is a self-contained scaffold under `orchestrator/src/bus/`. It is
**not yet wired into the existing Mars workflows, queue, or daemon** — that
integration is intentionally a follow-up task.

## Architecture

```
Writers (agents, TUI, web server)
       │
       ▼
SQLite (WAL mode)  ──►  Bus Daemon (single poller)  ──►  WebSocket clients
                                                         (agents, TUI, browser)
```

- Writers `INSERT` into the `events` table inside the same transaction as
  the state change they describe.
- The daemon is the **only** process that polls SQLite.
- The daemon fans events out over WebSocket with per-client topic filtering.
- A browser frontend connects to the same WebSocket — no separate bridge.

## Quickstart

Three terminals, all from `orchestrator/`:

```bash
# 1) start the daemon (logs `listening on :7777`)
pnpm tsx scripts/bus/run-daemon.ts

# 2) start a long-running listener (logs `subscribed to task.created`)
pnpm tsx examples/bus/agent-listener.ts

# 3) one-shot writer — emits task.created
pnpm tsx examples/bus/agent-writer.ts
```

Within ~100ms the listener prints the received `task.created`. About 1s
later the listener publishes a `task.completed`, which the daemon fans
back out.

To replay every historical event to new clients on startup, pass
`--from-start`:

```bash
pnpm tsx scripts/bus/run-daemon.ts --from-start
```

To wipe the dev DB:

```bash
pnpm tsx scripts/bus/reset-db.ts
```

## Browser smoke check

```bash
# 1) make sure the daemon is running (see Quickstart above)

# 2) compile the browser example to plain JS
pnpm tsc --target ES2022 --module ES2022 --moduleResolution bundler \
  --outDir examples/bus/dist examples/bus/browser-client.ts

# 3) serve the static folder
cd examples/bus && python3 -m http.server 8080
# open http://localhost:8080/index.html

# 4) in another terminal, fire a writer
pnpm tsx examples/bus/agent-writer.ts
```

You should see the new event appear at the top of the page within ~100ms.

## How to add a new event type

1. Add a zod schema entry in `src/bus/events.ts`:
   ```ts
   export const EventMap = {
     ...,
     'task.dropped': z.object({ taskId: z.string(), reason: z.string() }),
   } as const;
   ```
2. Publish it from a writer, inside a transaction:
   ```ts
   import { publish } from './publisher.js';
   db.transaction(() => {
     // mutate state
     publish(db, 'task.dropped', { taskId, reason });
   })();
   ```
3. Subscribe to it from any client:
   ```ts
   bus.on('task.dropped', ({ taskId, reason }) => { ... });
   ```

The publisher, daemon, and client are all generic over `EventMap`, so no
other file needs to change.

## Resource footprint (manual check)

```bash
pnpm tsx scripts/bus/run-daemon.ts &
sleep 2
ps -o rss= -p $(pgrep -f 'scripts/bus/run-daemon')
```

`rss` is reported in KB. Idle daemon sits well under 50MB on Node 22.

## Non-goals (deliberately omitted)

- Authentication / TLS (local-only for now; see `daemon.ts` TODO).
- Event pruning / retention (see `schema.ts` TODO).
- Distributed deployment across machines.
- Replacing `setInterval` polling with `sqlite3_update_hook` (future
  optimization, see `daemon.ts` TODO).
- Integration with the existing Mars task queue (`.mars/queue.db`) or the
  Mars daemon at `orchestrator/src/mastra/daemon/server.ts`. This task is
  a self-contained scaffold; integration is a separate follow-up.

## Swapping WebSocket for a Unix domain socket

If the browser frontend is dropped later, the WS layer can be replaced
with a UDS without changing any callers:

> In `daemon.ts` replace `new WebSocketServer({port})` with
> `net.createServer(...)` listening on a UDS path; in `client.ts` replace
> the `WebSocket` constructor with `net.connect(path)`. The wire protocol
> (newline JSON) is unchanged.
