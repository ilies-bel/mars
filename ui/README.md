# @mars/ui

Read-only Progress viewer for the Mars orchestrator queue. Standalone Vite SPA + a
tiny Node daemon that reads `<repo>/.mars/queue.db` directly. No coupling to the
orchestrator process — the contract is the SQLite schema.

## Stack

- Vite + React + TypeScript
- Tailwind v4 (CSS-first `@theme` tokens from `design/ui.pen`)
- `@libsql/client` against `<repo>/.mars/queue.db`
- `node:fs.watch` on the `.mars/` directory → SSE → browser refetch

## Dev

Two processes. The daemon serves `/api/tasks` and `/events` on `:7777`; Vite
serves the SPA on `:5173` and proxies `/api` + `/events` to the daemon.

```bash
npm install

# terminal 1 — daemon (defaults to cwd repo)
npm run dev:server -- --repo /path/to/target/repo

# terminal 2 — vite
npm run dev
# open http://localhost:5173
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

## Out of scope (v1)

- Writes (drag/add/delete)
- Triage / Run timeline / Topology routes
- Auth (daemon binds `127.0.0.1` by default)
