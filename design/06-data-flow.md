# 06 — Data flow

How files become pixels. Single-direction; UI never writes back.

## Endpoints (Hono)

```
GET  /                      → static bundle (Vite build)
GET  /api/flow              → resolved mars.flow.ts as JSON
GET  /api/runs              → list of runs (id, startedAt, status, stats)
GET  /api/runs/:id          → run detail (header stats only)
GET  /api/runs/:id/events   → all events for a run, paginated
GET  /api/inbox             → open inbox items (counts + titles only)
GET  /api/config            → resolved adapter list + version (no secrets)
GET  /api/events            → SSE stream of newly written events (live)
```

That's the entire server surface. No POST, no PUT, no DELETE — the UI
has no verb but GET. `mars ui` rejecting a non-GET at the middleware
layer is one line of defense; the deeper one is that the server has no
mutation handlers to call.

## Files → endpoints

| Endpoint | File source |
|---|---|
| `/api/flow` | `mars.flow.ts` (require + serialize at boot) |
| `/api/runs` | `metrics.db: RunMetric` |
| `/api/runs/:id/events` | `events.db: events WHERE runId = ?` |
| `/api/inbox` | `.mars/inbox.jsonl` (read-only fs.watch) |
| `/api/events` (SSE) | tail of `events.db` via SQLite triggers / poll |
| `/api/config` | resolved `mars.config.ts` minus any secret-shaped fields |

## SSE wiring

```
                                   ┌────────────────┐
   orchestrator ── writes ────────▶│  events.db     │
                                   └─────┬──────────┘
                                         │ poll 250ms (or sqlite-update-hook)
                                         ▼
                                   ┌────────────────┐
                                   │  Hono server   │
                                   └─────┬──────────┘
                                         │ SSE
                                         ▼
                                    React client
                                   (timeline view)
```

- Server polls `SELECT * FROM events WHERE id > ? ORDER BY id` at 250ms.
  Trivially correct; no write-side coupling.
- Each new row → `event: append` SSE message with the row JSON.
- Run boundaries broadcast `event: runStart` / `event: runEnd` so the
  client can swap header chrome without reading.

## Cache invalidation

Past runs are immutable — events for a closed run never change. The
client caches `/api/runs/:id/events` in memory keyed by run id. When the
server learns a run ended (`runEnd` SSE), it sends a final
`runMetrics` payload so the client can update header stats without
re-fetching.

## Failure modes

- **No `mars build` ever ran** → `/api/runs` returns `[]`, View 2 shows
  the empty-state CLI hint.
- **`mars.flow.ts` invalid** → server fails to boot; CLI prints the
  compiler error. UI is never partially usable.
- **`events.db` corrupt / unreadable** → SSE endpoint emits a single
  `error` message and closes. Client renders a banner: *"event store
  unreadable; run `mars audit`."* No retry storm.
- **Inbox file truncated mid-write** → server retries 3× at 50ms, then
  shows last good count and an `(stale)` chip in the footer.

## Boot order

```
mars ui
  ├─ resolve mars.config.ts           (fail fast if invalid)
  ├─ resolve mars.flow.ts             (fail fast if invalid)
  ├─ open events.db (read-only, WAL)
  ├─ open metrics.db (read-only, WAL)
  ├─ start fs.watch on .mars/inbox.jsonl
  ├─ start Hono on :7777
  └─ open browser to localhost:7777
```

If any step fails, the CLI exits with a nonzero code and a precise error
— never a half-booted server.

## Why no API for writes

Restated for emphasis. Adding a single mutation endpoint is the path to
re-implementing `mars` in JSX. The cost of typing the CLI command is
the friction that keeps the CLI sovereign.
