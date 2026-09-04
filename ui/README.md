# @mars/ui

Read-only Progress viewer for the Mars orchestrator queue. Standalone Vite SPA + a
tiny Node daemon that reads `<repo>/.mars/mars.db` directly. No coupling to the
orchestrator process — the contract is the SQLite schema.

## Stack

- Vite + React + TypeScript
- Tailwind v4 (CSS-first `@theme` tokens)
- `@libsql/client` against `<repo>/.mars/mars.db`
- `node:fs.watch` on the `.mars/` directory → SSE → browser refetch

## Dev

Two processes. The daemon serves `/api/tasks` and `/events` on `:7777`; Vite
serves the SPA on `:7173` and proxies `/api` + `/events` to the daemon.

```bash
npm install

# terminal 1 — daemon (defaults to cwd repo)
npm run dev:server -- --repo /path/to/target/repo

# terminal 2 — vite
npm run dev
# open http://localhost:7173
```

Repo resolution order: `--repo <path>` → `MARS_REPO` env var → `git rev-parse --show-toplevel` from cwd.

## Build & run

```bash
npm run build
npx mars-ui --repo /path/to/target/repo --port 7777
# open http://localhost:7777
```

The `mars-ui` binary boots the daemon and serves `dist/` on the same port.

## Endpoints

| Method | Path        | Description                       |
| ------ | ----------- | --------------------------------- |
| GET    | `/api/tasks` | All tasks ordered by `created_at` |
| GET    | `/events`    | SSE: `tasks` event on every write |
| GET    | `/healthz`   | `{ ok: true, repo }`              |

## Status → column mapping

| Column      | Statuses                                |
| ----------- | --------------------------------------- |
| BACKLOG     | `queued` (no plan)                      |
| PLANNED     | `queued` (plan present)                 |
| IN PROGRESS | `running`, `verifying`, `merging`       |
| DONE        | `done`, `failed` (failed = red border)  |

## Numbers

Every count shown in the UI — sidebar badge, board header, Control Room Now-strip,
chat greeting, and proposals header — comes from a single React Query hook:

```ts
import { useCounts } from '@/entities/counts/useCounts'

const { needsYou, running, verifying, merging, queued, blocked, failed, doneToday, proposals } = useCounts()
```

`useCounts()` fetches from `GET /api/counts` (→ daemon `GET /view/counts`), which
returns all task lifecycle counts plus `proposals.draft` and `proposals.total` in
one query. `needsYou` is sourced server-side from the action queue feed (same
predicate as `countNeedsYou`) so draft proposals are excluded and derived
conditions are included.

**Never add per-widget count calculations.** If you need a number that appears
in more than one place, extend `countsSchema` in `ui/src/shared/schemas.ts` and
add the field to `viewCounts` in `orchestrator/src/core/daemon/view/counts.ts`.

## Out of scope (v1)

- Writes (drag/add/delete)
- Triage / Run timeline / Topology routes
- Auth (daemon binds `127.0.0.1` by default)
