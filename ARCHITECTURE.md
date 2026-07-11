# Architecture

> Snapshot of what exists today. Honest about what's stubbed, missing, or
> out of step with [`VISION.md`](./VISION.md). When in doubt, the code at
> `orchestrator/src/` is the source of truth.

## Components

| Component | Path | Purpose |
| --- | --- | --- |
| Orchestrator CLI | `orchestrator/src/cli.ts` | Single entry point. All subcommands (`add`, `run`, `watch`, `init`, `plan`, `answer`, `show`, `list`, `where`, etc.). |
| @mars/workflow registration | `orchestrator/src/core/index.ts` | Registers workflows + tools on the in-house `@mars/workflow` engine. |
| Implement workflow | `orchestrator/src/core/workflows/implement-workflow.ts` | 4 steps: setup → claude → verify → merge. |
| Plan workflow | `orchestrator/src/core/workflows/plan-workflow.ts` | Auto-generates follow-up suggestions on draft tasks. |
| Init workflow | `orchestrator/src/core/workflows/init-workflow.ts` | Stack detection + specialist fetch + supervisor render. |
| Watcher daemon | `orchestrator/src/core/watcher.ts` | Polls `mars.db`, dispatches `queued` tasks to `implementWorkflow`. |
| Queue | `orchestrator/src/core/queue.ts` | LibSQL-backed task store. Tables: `tasks`, `task_suggestions`. |
| Git/claude/verify primitives | `orchestrator/src/core/lib/git.ts` | `runClaudeCode`, `createWorktree`, `verifyChanges`, `mergeBranch`, lock primitives. |
| Init pipeline | `orchestrator/src/init/` | Stack detection, GitHub HTTPS fetch against `ayush-that/sub-agents.directory`, supervisor templating. |
| UI | `ui/` | Vite + React SPA with a small Express SSE server (`ui/server/`). Reads `mars.db` directly via `@libsql/client`. Read-only. |
| Bundled prompts | `orchestrator/src/prompts/vcs-supervisor.md` | Inlined into `claude -p` for git conflict reconciliation. |
| Chat skill | `.claude/commands/mars/feature/chat.md` | Slash command for refining drafts. **Out of step with current code** — see "Drift" below. |

## Runtime flow

### Implement workflow (the hot path)

`orchestrator/src/core/workflows/implement-workflow.ts`

```
                        mars.db row (status=queued)
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
   │  2. run-claude-code                                         │
   │     claude -p "<prompt + plan_functional + plan_technical>" │
   │       --output-format json --dangerously-skip-permissions   │
   │     20-min timeout. Captures session_id.                    │
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
   │    claude -p with        │
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

Side effects: shell out to `git`, `claude`, project's typecheck/test/lint.
All wrapped in `orchestrator/src/core/lib/git.ts`. No LLM SDK calls.

### Plan workflow

`orchestrator/src/core/workflows/plan-workflow.ts`

Single step: `generate-plan`. Calls `claude -p` against the draft's prompt,
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
| `mars.db` | LibSQL: `tasks`, `task_suggestions` | Active |
| `mastra.db` | Pre-`@mars/workflow` legacy observability DB (cleaned up by `removeLegacyMastraDb` in server.ts) | Legacy |
| ~~`queue.db`~~ | Legacy pre-merge artifact (merged into `mars.db`) | **Dead** |
| ~~`state.db`~~ | Legacy pre-merge artifact (merged into `mars.db`) | **Dead** |
| `cache/sub-agents/trees.json` | 7-day cached specialist index | Active |
| `supervisors/<name>.md` | Generated supervisor system prompts | Active |
| `supervisors/manifest.json` | Supervisor registry | Active |
| `supervisors/README.md` | Generated index of supervisors | Active |
| `worktrees/<task-id>/` | Per-task git worktree | Active |
| `.merge.lock` | File lock serializing the merge step | Active |

Add `/.mars/` to the target repo's `.gitignore`.

## Task schema (`mars.db`)

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

Every call out to a model goes through `runClaudeCode` in
`orchestrator/src/core/lib/git.ts`:

```ts
runClaudeCode({ cwd, prompt, timeoutMs })
  → spawns: claude -p "<prompt>" --output-format json
                     --dangerously-skip-permissions
  → returns: { exitCode, stdout, stderr, sessionId }
```

`stdout` is a JSON envelope; `result` field is the model text. Structured
output is enforced in the prompt (return strict JSON, no fences) and parsed
with zod, tolerant of leading/trailing prose. See `parsePlannerOutput` in
`plan-workflow.ts` for the canonical pattern.

No `@ai-sdk/*` package is or will be installed. No `Agent({ model })`
strings. No `ANTHROPIC_API_KEY`. See
`orchestrator/AGENTS.md` for the boundary contract.

## UI

`ui/`

- **Stack:** Vite + React + TypeScript + Tailwind v4 + `@libsql/client`.
- **Server:** `ui/server/index.ts` — small Express + SSE on port 7777.
  - `GET /api/tasks` — all tasks ordered by `created_at`.
  - `GET /events` — SSE; emits `{ type: 'tasks' }` on every `.mars/`
    file change (via `node:fs.watch`).
  - `GET /healthz` — `{ ok, repo }`.
- **SPA:** Read-only Kanban over `mars.db`.
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
   `mars.db` (`plan_functional` / `plan_technical`).
2. **`ready` status** is in the schema and CLI but redundant with
   `queued` per the vision. Plan to remove.
3. **`mars run`** (synchronous batch) overlaps with `mars daemon`. Vision
   says watch is canonical.
4. ~~**`state.db`**~~ merged into `mars.db` — no longer exists as a separate file.
5. **README points to** `agents/` and `docs/CONTRACTS.md` — neither
   directory/file exists. The relevant agent definitions are in
   `.agents/` and `.claude/agents/`.

These are tracked in [VISION.md → Open questions](./VISION.md#open-questions).
