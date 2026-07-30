# Architecture

> Snapshot of what exists today. Honest about what's stubbed, missing, or
> out of step with [`VISION.md`](./VISION.md). When in doubt, the code at
> `orchestrator/src/` is the source of truth.

## Components

| Component | Path | Purpose |
| --- | --- | --- |
| Orchestrator CLI | `orchestrator/src/cli.ts` | Single entry point. All subcommands (`add`, `run`, `watch`, `init`, `plan`, `answer`, `show`, `list`, `where`, etc.). |
| @mars/workflow registration | `orchestrator/src/core/index.ts` | Registers workflows + tools on the in-house `@mars/workflow` engine. |
| Implement workflow | `orchestrator/src/core/workflows/implement-workflow.ts` | 4 steps: setup → agent → verify → merge. |
| Plan workflow | `orchestrator/src/core/workflows/plan-workflow.ts` | Auto-generates follow-up suggestions on draft tasks. |
| Init workflow | `orchestrator/src/core/workflows/init-workflow.ts` | Stack detection + specialist fetch + supervisor render. |
| Watcher daemon | `orchestrator/src/core/watcher.ts` | Polls the `tasks` table, dispatches `queued` tasks to `implementWorkflow`. |
| Queue | `orchestrator/src/core/queue.ts` | Postgres-backed task store (embedded PG via `core/lib/db.ts`). Tables: `tasks`, `task_suggestions`. |
| Provider registry | `orchestrator/src/core/workers/providers.ts` | Provider-neutral dispatch, semantic model tiers, and Claude/Codex/Gemini adapters. |
| Git/verify primitives | `orchestrator/src/core/lib/git.ts` | Worktree, verification, merge, lock, and shared subprocess primitives. |
| Init pipeline | `orchestrator/src/init/` | Stack detection, GitHub HTTPS fetch against `ayush-that/sub-agents.directory`, supervisor templating. |
| UI | `ui/` | Vite + React SPA with a small Bun.serve SSE server (`ui/server/`). Reads task state via the daemon HTTP API. Read-only. |
| Bundled prompts | `orchestrator/src/prompts/vcs-supervisor.md` | Sent through the selected provider for git conflict reconciliation. |
| Chat skill | `.claude/commands/mars/feature/chat.md` | Slash command for refining drafts. **Out of step with current code** — see "Drift" below. |

## Runtime flow

### Implement workflow (the hot path)

`orchestrator/src/core/workflows/implement-workflow.ts`

```
                        tasks row (status=queued)
                                 │
                                 ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  1. setup-worktree                                          │
   │     git worktree add -b task/<id> .mars/worktrees/<id>      │
   │     <integration>                                           │
   │     status: queued → running                                │
   └─────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  2. run-agent                                               │
   │     selected provider + provider-native model tier          │
   │     Codex default: codex exec --ephemeral --json            │
   │     Captures normalized events and session id if exposed.   │
   └─────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  3. verify       status: running → verifying                │
   │     typecheck (tsc) → tests → lint (biome)                  │
   │     Sequential; first failure short-circuits.               │
   └─────────────────────────────────────────────────────────────┘
                                 │
                          pass   │   fail
                          ┌──────┴──────┐
                          ▼             ▼
   ┌──────────────────────────┐   ┌───────────────────────────────┐
   │  4. merge                │   │  status: failed               │
   │  acquire .merge.lock     │   │  worktree retained for triage │
   │  (file lock, 5min ttl)   │   └───────────────────────────────┘
   │  git merge task/<id>     │
   │  → integration            │
   │                          │
   │  on conflict:            │
   │    selected provider     │
   │    vcs-supervisor.md     │
   │    inlined; reconcile,   │
   │    re-verify, commit.    │
   │  unresolvable: --abort,  │
   │  status: failed.         │
   │                          │
   │  status: merging → done  │
   │  worktree removed        │
   └──────────────────────────┘
```

Side effects: shell out to `git`, the selected agent CLI, and the project's
typecheck/test/lint commands. Provider-specific behavior stays in
`orchestrator/src/core/workers/providers*`. No LLM SDK calls.

### Plan workflow

`orchestrator/src/core/workflows/plan-workflow.ts`

Single step: `generate-plan`. Calls the Planner Worker through the selected provider,
parses a JSON envelope (tolerating extra prose), and writes rows into the
`task_suggestions` table.

`mars plan <id>` runs it; `mars plan <id> --refresh` regenerates.

> **Drift note.** This auto-suggestion generation overlaps with what the
> chat skill is supposed to do. Vision says the chat skill is the primary
> refinement loop — this workflow may be redundant.

### Init workflow

`orchestrator/src/core/workflows/init-workflow.ts`

Three steps:

1. **detect-stack** (`orchestrator/src/init/detect-stack.ts`). Inspects
   `package.json`, `tsconfig.json`, `Dockerfile`, file extensions; emits
   detected languages/frameworks and a list of proposed supervisors with
   external specialist slugs.
2. **render-supervisors** (`orchestrator/src/init/fetch-specialist.ts` +
   `render.ts`). HTTPS fetch against
   `ayush-that/sub-agents.directory` (GitHub trees API + raw blobs), 7-day
   cache at `.mars/cache/sub-agents/trees.json`. Templates the supervisor
   skeleton with detected stack + specialist body.
3. **write-manifest**. Writes supervisor `.md` files to
   `.mars/supervisors/`, plus `manifest.json` and a `README.md`.

Outcomes per specialist are recorded as hit/miss/error.

### Watcher

`orchestrator/src/core/watcher.ts`

```
loop every <intervalMs> (default 2000):
  pick rows where status='queued' AND not in-flight
  for each: claimReadyTask() — atomic UPDATE, sets status='running'
  dispatch to implementWorkflow in parallel
  on dispatch error: status='failed' with error message
on SIGTERM: drain in-flight, exit
```

> **Drift note.** Today the watcher polls `queued`. The CLI also has a
> `ready` status and a `mars ready <id>` command. Vision collapses these
> into a single `queued` state — the `ready` state is currently dead
> weight in the UX.

## State

All state for a target repo lives in `<target-repo>/.mars/`:

| File | Purpose | Status |
| --- | --- | --- |
| `pg/data/` | Embedded PostgreSQL data dir (daemon-provisioned; `tasks`, `task_suggestions`, …) | Active |
| `pg.port` / `pg.dsn` | Published PG port and connection string — consumers read the file, never guess | Active |
| `mastra.db` | Pre-`@mars/workflow` legacy observability DB (cleaned up by `removeLegacyMastraDb` in server.ts) | Legacy |
| ~~`mars.db`~~ | Legacy SQLite store, imported once into PG and renamed `mars.db.bak-<ts>` | **Dead** |
| ~~`queue.db`~~ / ~~`state.db`~~ | Legacy pre-merge artifacts (merged into `mars.db` before the PG cut) | **Dead** |
| `cache/sub-agents/trees.json` | 7-day cached specialist index | Active |
| `supervisors/<name>.md` | Generated supervisor system prompts | Active |
| `supervisors/manifest.json` | Supervisor registry | Active |
| `supervisors/README.md` | Generated index of supervisors | Active |
| `worktrees/<task-id>/` | Per-task git worktree | Active |
| `.merge.lock` | File lock serializing the merge step | Active |

Add `/.mars/` to the target repo's `.gitignore`.

## Task schema

`orchestrator/src/core/queue.ts`

**`tasks`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | 8-char id |
| `prompt` | TEXT | The user's instruction |
| `status` | TEXT | `draft \| queued \| ready \| running \| verifying \| merging \| done \| failed` |
| `plan_functional` | TEXT | Filled by chat skill / `set-functional` |
| `plan_technical` | TEXT | Filled by chat skill / `set-technical` |
| `branch` | TEXT | `task/<id>` |
| `worktree_path` | TEXT | Absolute |
| `claude_session_id` | TEXT | From `claude -p --output-format json` |
| `error` | TEXT | Failure reason, when `status='failed'` |
| `created_at`, `updated_at` | TEXT | ISO timestamps |

**`task_suggestions`**: `id`, `source_task_id`, `title`, `prompt`,
`rationale`, `status` (`proposed|accepted|dismissed`), `created_task_id`.

> **Drift note.** Vision keeps `queued` and drops `ready`. Today both
> exist. Reconcile with a migration when the CLI is cleaned up.

## CLI surface today

`orchestrator/src/cli.ts`

| Command | Purpose |
| --- | --- |
| `mars init [--force] [--no-fetch] [--dry-run] [--refresh]` | Detect stack, fetch specialists, generate `.mars/supervisors/`. |
| `mars add "<prompt>" [--draft] [--functional ... ] [--technical ...]` | Enqueue a task. `--draft` triggers plan workflow. |
| `mars plan <id> [--refresh]` | Run plan workflow on a draft. |
| `mars set-functional <id> <text\|@file>` | Write `plan_functional`. |
| `mars set-technical <id> <text\|@file>` | Write `plan_technical`. |
| `mars ready <id>` | Mark a queued task `ready` (drift — see vision). |
| `mars list [status]` | List tasks. |
| `mars show <id>` | Print a task with plans and suggestions. |
| `mars run` | One-shot dispatch all `queued` tasks (drift — vision says watch is canonical). |
| `mars daemon <start\|stop\|status\|reload>` | Daemon dispatcher control. |
| `mars where` | Print resolved repo + state paths. |

Repo resolution order: `--repo` flag → `MARS_REPO` env → `git rev-parse
--show-toplevel`.

## LLM call boundary

Every call out to a model goes through a named Worker or
`runHeadlessProvider` in `orchestrator/src/core/workers/providers.ts`:

```ts
runHeadlessProvider(prompt, { cwd, modelTier: 'balanced' })
  → resolves: MARS_WORKER_PROVIDER or daemon.json.defaultProvider
  → maps: semantic tier to a provider-native model id
  → spawns: provider adapter (Codex default: codex exec --ephemeral --json)
  → returns: { exitCode, stdout, stderr, sessionId, conversation }
```

`stdout` is a JSON envelope; `result` field is the model text. Structured
output is enforced in the prompt (return strict JSON, no fences) and parsed
with zod, tolerant of leading/trailing prose. See `parsePlannerOutput` in
`plan-workflow.ts` for the canonical pattern.

Codex authentication is owned by the CLI and checked with `codex login status`;
Mars never reads or copies the cached OAuth credentials. No `@ai-sdk/*` package
is installed and provider CLIs do not leak into workflow code. See
`orchestrator/AGENTS.md` for the boundary contract.

## UI

`ui/`

- **Stack:** Vite + React + TypeScript + Tailwind v4.
- **Server:** `ui/server/index.ts` — small Bun.serve + SSE on port 7777.
  - `GET /api/tasks` — all tasks ordered by `created_at`.
  - `GET /events` — SSE; emits `{ type: 'tasks' }` on every `.mars/`
    file change (via `node:fs.watch`).
  - `GET /healthz` — `{ ok, repo }`.
- **SPA:** Read-only Kanban over the Mars database.
  - **BACKLOG:** `queued` with no plan
  - **PLANNED:** `queued` with plan
  - **IN PROGRESS:** `running`, `verifying`, `merging`
  - **DONE:** `done`, `failed` (red border)

The CLI is the only write surface. The UI never mutates state.

## Drift between docs and code

Captured here so future-you doesn't trust either side blindly.

1. **Chat skill describes a different system.** `mars:feature:chat`
   references `features/<id>.md`, `mars feature refine`, `mars rebuild`,
   and `.mars/state.db`. None of those exist in the orchestrator. Vision
   is DB-first; the skill needs to be rewritten to write directly into
   the Mars database (`plan_functional` / `plan_technical`).
2. **`ready` status** is in the schema and CLI but redundant with
   `queued` per the vision. Plan to remove.
3. **`mars run`** (synchronous batch) overlaps with `mars daemon`. Vision
   says watch is canonical.
4. ~~**`state.db`**~~ merged into `mars.db` (itself since imported into
   embedded PG) — no longer exists as a separate file.
5. **README points to** `agents/` and `docs/CONTRACTS.md` — neither
   directory/file exists. The relevant agent definitions are in
   `.agents/` and `.claude/agents/`.

These are tracked in [VISION.md → Open questions](./VISION.md#open-questions).
